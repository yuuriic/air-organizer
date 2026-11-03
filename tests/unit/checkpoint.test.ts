import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ResumeRejectedError,
  canonicalJson,
  compareCheckpointScope,
  isResumable,
  sealCheckpoint,
  validateCheckpoint,
  type CheckpointFolder,
  type TreeCheckpoint,
} from '../../src/core/checkpoint.js';
import { scanTree, type TreeCheckpointSnapshot } from '../../src/core/tree-scanner.js';
import type { ResumeMode, TreeLimits, TreeResult } from '../../src/types/inventory.js';
import { SimNavigator, file, files, folder, type SimBehavior, type SimNode } from '../sim-navigator.js';

const pseudonymize = (v: string) => createHmac('sha256', 'chave-de-teste').update(v).digest('hex').slice(0, 32);
const WIDE: TreeLimits = { maxDepth: 10, maxFolders: 100, maxItems: 10_000, maxPagesPerFolder: 50 };

/** Raiz → A (A1 → arquivo; arquivo), B (C → arquivo), arquivo. */
function tree(mutate: { aCreatedAt?: string; extraInA1?: boolean; withoutB?: boolean } = {}): SimNode {
  return folder('root', 'Raiz', [
    folder('a', 'A', [folder('a1', 'A1', [file('f1'), ...(mutate.extraInA1 ? [file('novo')] : [])]), file('f2')], mutate.aCreatedAt),
    ...(mutate.withoutB ? [] : [folder('b', 'B', [folder('c', 'C', [file('f4')])])]),
    file('f3'),
  ]);
}

async function run(root: SimNode, limits: TreeLimits, behavior: SimBehavior = {}, resumeFrom?: CheckpointFolder[], mode: ResumeMode = 'fast') {
  const nav = new SimNavigator(root, behavior);
  const snapshots: TreeCheckpointSnapshot[] = [];
  const result = await scanTree(nav, limits, {
    checkpoint: { pseudonymize, save: async (s) => void snapshots.push(structuredClone(s)), ...(resumeFrom ? { resume: { from: resumeFrom, mode } } : {}) },
  });
  return { nav, result, snapshots, checkpoint: snapshots.at(-1)!.folders };
}

const shape = (r: TreeResult) => r.folders.map((f) => [f.ref, f.parentRef, f.depth, f.status, f.subtreeStatus, f.reasons]);

describe('checkpoint — gravação', () => {
  it('grava a cada passo e nada do que é persistido contém nomes, caminhos ou URLs', async () => {
    const secret = ['BELTRANA DE TAL', 'REGISTRO 111.222.333-44', 'CICRANO REG 00000'];
    const root = folder('root', secret[0]!, [folder('p', secret[1]!, [file('x', `${secret[2]}.pdf`)])]);
    const { snapshots } = await run(root, WIDE);
    expect(snapshots.length).toBeGreaterThan(2);
    // O que vai para o arquivo (de `final`, só o status; ver CheckpointSession.save).
    const text = JSON.stringify(snapshots.map(({ folders, totals, limitsReached }) => ({ folders, totals, limitsReached })));
    for (const s of [...secret, 'air.test', 'my-air', '/', '.pdf']) expect(text).not.toContain(s);
  });

  it('a última gravação traz o resultado final e marca tudo como assentado', async () => {
    const { snapshots, result } = await run(tree(), WIDE);
    expect(snapshots.at(-1)!.final?.status).toBe('complete');
    expect(snapshots.at(-1)!.folders.every((f) => f.settled)).toBe(true);
    expect(isResumable(snapshots.at(-1)!.folders)).toBe(false);
    expect(result.resume).toBeUndefined();
  });
});

describe('checkpoint — retomada', () => {
  it('após perda de navegação, retoma sem reabrir subárvores assentadas e sem duplicar', async () => {
    const first = await run(tree(), WIDE, { lose: ['b'] });
    expect(first.result.status).toBe('failed');
    expect(isResumable(first.checkpoint)).toBe(true);

    const second = await run(tree(), WIDE, {}, first.checkpoint);
    expect(second.nav.log).toEqual(['scan:root', 'open:b', 'scan:b', 'open:c', 'scan:c', 'back:c', 'back:b']); // "A" não é reaberta
    expect(second.result.status).toBe('complete');
    expect(second.result.resume).toMatchObject({ reusedFolders: 2 });

    const fresh = await run(tree(), WIDE);
    expect(shape(second.result)).toEqual(shape(fresh.result));
    expect(second.result.totals).toEqual(fresh.result.totals);
    const a = second.result.folders.find((f) => f.name === 'A')!;
    expect(a.reusedFrom).toBeDefined();
    expect(second.result.folders.find((f) => f.parentRef === a.ref)?.name).toBeUndefined(); // descendente sem nome
  });

  it('limite atingido: com os mesmos limites continua parcial; só com limites maiores fica completa', async () => {
    const first = await run(tree(), { ...WIDE, maxFolders: 2 });
    expect(first.result.status).toBe('partial');

    const same = await run(tree(), { ...WIDE, maxFolders: 2 }, {}, first.checkpoint);
    expect(same.result.status).toBe('partial');
    expect(same.result.limitsReached).toEqual(['max-folders']);

    const wider = await run(tree(), WIDE, {}, same.checkpoint);
    expect(wider.result.status).toBe('complete');
    expect(shape(wider.result)).toEqual(shape((await run(tree(), WIDE)).result));
  });

  it('parcial pelo conteúdo continua parcial após a retomada', async () => {
    const root = () => folder('root', 'Raiz', [folder('a', 'A', [{ id: 'u', name: 'Talvez pasta', type: 'unknown' }]), folder('b', 'B')]);
    const first = await run(root(), WIDE, { lose: ['b'] });
    const second = await run(root(), WIDE, {}, first.checkpoint);
    expect(second.nav.opened()).toEqual(['b']);
    expect(second.result.folders.find((f) => f.name === 'A')).toMatchObject({ subtreeStatus: 'partial', reasons: ['unknown-items'] });
    expect(second.result.status).toBe('partial');
  });

  it('linha da subpasta mudou no pai (metadados): ela é relida; abaixo dela, cada linha é conferida de novo', async () => {
    const first = await run(tree(), WIDE, { lose: ['b'] });
    const second = await run(tree({ aCreatedAt: '09/09/2030' }), WIDE, {}, first.checkpoint);
    expect(second.nav.opened()).toEqual(['a', 'b', 'c']); // "A" reaberta; "A1", com linha idêntica, não
    expect(second.result.resume?.reusedFolders).toBe(1);
    expect(second.result.status).toBe('complete');
  });

  it('limitação documentada: mudança DENTRO de subárvore reaproveitada não é detectada', async () => {
    const first = await run(tree(), WIDE, { lose: ['b'] });
    const second = await run(tree({ extraInA1: true }), WIDE, {}, first.checkpoint);
    expect(second.nav.opened()).not.toContain('a1');
    expect(second.result.totals.items).toBe((await run(tree(), WIDE)).result.totals.items); // o item novo não aparece
    expect(second.result.resume?.oldestReusedObservation).toBeDefined(); // a CLI avisa com a data
  });

  it('maxDepth menor na retomada: subárvore mais profunda que o limite não é reaproveitada', async () => {
    const first = await run(tree(), WIDE, { lose: ['b'] });
    const second = await run(tree(), { ...WIDE, maxDepth: 1 }, {}, first.checkpoint);
    expect(second.nav.opened()).toEqual(['a', 'b']);
    expect(second.result.folders.find((f) => f.name === 'A1')?.reasons).toEqual(['max-depth']);
  });

  it('pasta inicial diferente: recusa antes de qualquer clique', async () => {
    const first = await run(tree(), WIDE, { lose: ['b'] });
    const other = folder('outra', 'Raiz', [folder('a', 'A')]);
    const nav = new SimNavigator(other);
    const attempt = scanTree(nav, WIDE, { checkpoint: { pseudonymize, save: async () => {}, resume: { from: first.checkpoint, mode: 'fast' } } });
    await expect(attempt).rejects.toThrow(ResumeRejectedError);
    await expect(attempt).rejects.toMatchObject({ rejection: { code: 'start-folder-mismatch' } });
    expect(nav.log).toEqual([]);
  });

  it('subpasta com várias páginas: a pasta com pendência é relida desde a página 1 sem duplicar itens', async () => {
    const root = () => folder('root', 'Raiz', [folder('a', 'A', files('a', 65))]);
    const first = await run(root(), { ...WIDE, maxPagesPerFolder: 2 }, { pageSize: 30 });
    expect(first.result.folders.find((f) => f.name === 'A')?.reasons).toEqual(['max-pages']);
    const second = await run(root(), WIDE, { pageSize: 30 }, first.checkpoint);
    const a = second.result.folders.find((f) => f.name === 'A')!;
    expect(a).toMatchObject({ status: 'complete', counts: { items: 65, pagesRead: 3 } });
    expect(new Set(a.items.map((i) => i.observationKey)).size).toBe(65);
    expect(second.result.status).toBe('complete');
  });
});

describe('validateCheckpoint e escopo', () => {
  const now = new Date('2026-11-03T12:00:00.000Z');
  const opts = { pseudonymize, now, retentionMs: 7 * 24 * 3600 * 1000 };
  const scope = { instanceId: 'i', sectorId: 's', startKeyId: 'k' };

  async function sealed(overrides: Partial<TreeCheckpoint> = {}, behavior: SimBehavior = { lose: ['b'] }): Promise<TreeCheckpoint> {
    const { snapshots } = await run(tree(), WIDE, behavior);
    const last = snapshots.at(-1)!;
    return sealCheckpoint(
      {
        kind: 'air-organizer/tree-checkpoint',
        schemaVersion: 1,
        runId: 'r1',
        createdAt: '2026-11-03T10:00:00.000Z',
        updatedAt: '2026-11-03T11:00:00.000Z',
        state: last.final!.status,
        scope,
        limits: WIDE,
        limitsReached: last.limitsReached,
        totals: last.totals,
        sessions: [],
        folders: last.folders,
        ...overrides,
      },
      pseudonymize,
    );
  }

  it('aceita checkpoint íntegro, dentro do prazo e com pendências retomáveis', async () => {
    expect(validateCheckpoint(JSON.parse(JSON.stringify(await sealed())), opts)).toHaveProperty('checkpoint');
  });

  it.each<[string, (cp: TreeCheckpoint) => unknown, string]>([
    ['outro formato', (cp) => ({ ...cp, kind: 'x' }), 'schema'],
    ['campo alterado depois de gravado', (cp) => ({ ...cp, totals: { ...cp.totals, items: 999 } }), 'integrity'],
    ['pasta removida do arquivo', (cp) => ({ ...cp, folders: cp.folders.slice(1) }), 'integrity'],
  ])('recusa: %s', async (_, change, code) => {
    expect(validateCheckpoint(change(await sealed()), opts)).toMatchObject({ rejection: { code } });
  });

  it('recusa checkpoint de outra chave local', async () => {
    const other = (v: string) => createHmac('sha256', 'outra-chave').update(v).digest('hex').slice(0, 32);
    expect(validateCheckpoint(await sealed(), { ...opts, pseudonymize: other })).toMatchObject({ rejection: { code: 'integrity' } });
  });

  it('recusa fora do prazo, concluída ou sem pendência retomável', async () => {
    expect(validateCheckpoint(await sealed({ updatedAt: '2026-10-01T00:00:00.000Z' }), opts)).toMatchObject({ rejection: { code: 'expired' } });
    expect(validateCheckpoint(await sealed({ state: 'complete' }, {}), opts)).toMatchObject({ rejection: { code: 'finished' } });
    // Parcial só por conteúdo (homônimos): repetir daria o mesmo resultado.
    const { snapshots } = await run(folder('root', 'Raiz', [folder('x1', 'Docs'), folder('x2', 'docs')]), WIDE);
    expect(isResumable(snapshots.at(-1)!.folders)).toBe(false);
  });

  it('confere instância, cliente, setor e pasta inicial', () => {
    expect(compareCheckpointScope(scope, scope)).toBeUndefined();
    expect(compareCheckpointScope(scope, { ...scope, instanceId: 'x' })?.code).toBe('instance-mismatch');
    expect(compareCheckpointScope(scope, { ...scope, clientId: 'c' })?.code).toBe('client-mismatch');
    expect(compareCheckpointScope(scope, { ...scope, sectorId: undefined })?.code).toBe('sector-mismatch');
    expect(compareCheckpointScope(scope, { ...scope, startKeyId: 'y' })?.code).toBe('start-folder-mismatch');
  });

  it('JSON canônico não depende da ordem das chaves', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }] })).toBe(canonicalJson({ a: [{ d: 2 }], b: 1 }));
  });
});

describe('modos de retomada: rápido x verificado', () => {
  const interrupted = () => run(tree(), WIDE, { lose: ['b'] });

  it('verificado reabre e relê tudo, compara com o checkpoint e é elegível para planejamento', async () => {
    const first = await interrupted();
    const verified = await run(tree(), WIDE, {}, first.checkpoint, 'verified');
    expect(verified.nav.opened()).toEqual(['a', 'a1', 'b', 'c']);
    expect(verified.result.status).toBe('complete');
    expect(verified.result.resume).toMatchObject({ mode: 'verified', reusedFolders: 0, unchanged: 3, changed: 0, new: 2, removed: 0 });
    expect(verified.result.verification).toEqual({ contentRevalidated: true, eligibleForPlanning: true });
    expect(verified.result.folders.every((f) => f.verification !== 'reused')).toBe(true);
  });

  it('rápido reaproveita, mas nunca é elegível para planejamento, mesmo completo', async () => {
    const first = await interrupted();
    const fast = await run(tree(), WIDE, {}, first.checkpoint, 'fast');
    expect(fast.result.status).toBe('complete');
    expect(fast.result.resume).toMatchObject({ mode: 'fast', reusedFolders: 2 });
    expect(fast.result.verification).toEqual({ contentRevalidated: false, eligibleForPlanning: false });
    expect(fast.result.folders.filter((f) => f.verification === 'reused')).toHaveLength(2);
  });

  it('alteração interna sem mudança na linha do pai: só a verificada detecta', async () => {
    const first = await interrupted();
    const fresh = await run(tree({ extraInA1: true }), WIDE);

    const fast = await run(tree({ extraInA1: true }), WIDE, {}, first.checkpoint, 'fast');
    expect(fast.nav.opened()).not.toContain('a1');
    expect(fast.result.totals.items).toBe(fresh.result.totals.items - 1); // o item novo não aparece

    const verified = await run(tree({ extraInA1: true }), WIDE, {}, first.checkpoint, 'verified');
    expect(verified.result.totals).toEqual(fresh.result.totals);
    const byName = (n: string) => verified.result.folders.find((f) => f.name === n)!;
    expect(byName('A').verification).toBe('unchanged'); // a linha de A1 no pai não mudou
    expect(byName('A1').verification).toBe('changed');
    expect(verified.result.resume).toMatchObject({ changed: 1 });
  });

  it('verificado não duplica pastas nem itens', async () => {
    const first = await interrupted();
    const verified = await run(tree(), WIDE, {}, first.checkpoint, 'verified');
    const fresh = await run(tree(), WIDE);
    expect(shape(verified.result)).toEqual(shape(fresh.result));
    expect(verified.result.totals).toEqual(fresh.result.totals);
    for (const f of verified.result.folders) expect(new Set(f.items.map((i) => i.observationKey)).size).toBe(f.items.length);
  });

  it('verificado preserva os limites: com os mesmos limites que pararam, continua parcial e não elegível', async () => {
    const first = await run(tree(), { ...WIDE, maxFolders: 2 });
    const verified = await run(tree(), { ...WIDE, maxFolders: 2 }, {}, first.checkpoint, 'verified');
    expect(verified.nav.opened()).toEqual(['a']);
    expect(verified.result).toMatchObject({ status: 'partial', limitsReached: ['max-folders'] });
    expect(verified.result.verification).toEqual({ contentRevalidated: true, eligibleForPlanning: false });
  });

  it('verificado detecta subpasta removida desde o checkpoint', async () => {
    const first = await interrupted();
    const verified = await run(tree({ withoutB: true }), WIDE, {}, first.checkpoint, 'verified');
    expect(verified.result.resume).toMatchObject({ removed: 1 });
  });

  it('falha de navegação durante a retomada verificada: interrompe, e o checkpoint segue retomável', async () => {
    const first = await interrupted();
    const broken = await run(tree(), WIDE, { lose: ['a1'] }, first.checkpoint, 'verified');
    expect(broken.result).toMatchObject({ status: 'failed', abort: { reason: 'navigation-lost' } });
    expect(broken.result.verification.eligibleForPlanning).toBe(false);
    expect(isResumable(broken.checkpoint)).toBe(true);
    const again = await run(tree(), WIDE, {}, broken.checkpoint, 'verified');
    expect(again.result.status).toBe('complete');
  });

  it('execução nova completa é elegível; o checkpoint de qualquer modo não contém nomes', async () => {
    const fresh = await run(tree(), WIDE);
    expect(fresh.result.verification).toEqual({ contentRevalidated: true, eligibleForPlanning: true });
    expect(fresh.result.resume).toBeUndefined();
    const first = await interrupted();
    for (const mode of ['fast', 'verified'] as const) {
      const r = await run(tree(), WIDE, {}, first.checkpoint, mode);
      const text = JSON.stringify(r.snapshots.map(({ folders, totals, limitsReached }) => ({ folders, totals, limitsReached })));
      for (const s of ['"Raiz"', '"A1"', 'air.test', 'my-air', '.pdf', '/Raiz']) expect(text).not.toContain(s);
    }
  });
});
