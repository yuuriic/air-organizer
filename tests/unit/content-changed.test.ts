import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isResumable, isSettledSubtree, type CheckpointFolder } from '../../src/core/checkpoint.js';
import { diagnosticReport, formatTreeEvent, scanTree, type TreeCheckpointSnapshot } from '../../src/core/tree-scanner.js';
import type { ResumeMode, TreeEvent, TreeLimits } from '../../src/types/inventory.js';
import { SimNavigator, file, folder, type SimBehavior, type SimNode } from '../sim-navigator.js';

/**
 * ADR-013: na volta ao pai, identidade confirmada com total/listagem divergentes = 'content-changed'.
 * A volta é aceita, a pasta e os ancestrais deixam de ser completos, as subpastas ainda não abertas
 * não são abertas a partir da listagem antiga, e nada é relido em loop.
 */
const pseudonymize = (v: string) => createHmac('sha256', 'k').update(v).digest('hex').slice(0, 32);
const WIDE: TreeLimits = { maxDepth: 10, maxFolders: 100, maxItems: 10_000, maxPagesPerFolder: 50 };

/** Raiz → P (X → arquivo, Y, Z), Q. */
const tree = (): SimNode => folder('root', 'Raiz', [folder('p', 'P', [folder('x', 'X', [file('f1')]), folder('y', 'Y'), folder('z', 'Z')]), folder('q', 'Q')]);

async function run(behavior: SimBehavior, resume?: { from: CheckpointFolder[]; mode: ResumeMode }) {
  const nav = new SimNavigator(tree(), behavior);
  const events: TreeEvent[] = [];
  let saved: TreeCheckpointSnapshot | undefined;
  const result = await scanTree(nav, WIDE, {
    onEvent: (e) => events.push(e),
    checkpoint: { pseudonymize, save: async (s) => void (saved = structuredClone(s)), resume },
  });
  return { nav, result, events, checkpoint: saved!.folders };
}

const byName = (r: Awaited<ReturnType<typeof run>>['result'], name: string) => r.folders.find((f) => f.name === name)!;

describe('ADR-013: conteúdo divergente na volta ao pai', () => {
  it('aceita a volta, marca a pasta e invalida a completude dela e dos ancestrais', async () => {
    const { result } = await run({ changeOnBack: { x: { total: true, listing: true } } });
    expect(byName(result, 'P')).toMatchObject({ status: 'partial', subtreeStatus: 'partial', reasons: ['content-changed'] });
    expect(byName(result, 'Raiz').subtreeStatus).toBe('partial');
    expect(byName(result, 'X')).toMatchObject({ status: 'complete', subtreeStatus: 'complete' }); // a filha lida continua válida
    expect(result.status).toBe('partial');
    expect(result.abort).toBeUndefined(); // não é falha de navegação
    expect(result.navigation).toEqual({ contentChanged: 1, identityMismatch: 0, navigationFailed: 0 });
    expect(result.verification.eligibleForPlanning).toBe(false);
  });

  it('listagem alterada com o mesmo total também é content-changed', async () => {
    const { result } = await run({ changeOnBack: { x: { total: false, listing: true } } });
    expect(byName(result, 'P').reasons).toEqual(['content-changed']);
    expect(result.navigation.contentChanged).toBe(1);
  });

  it('nenhum clique a partir da listagem antiga: irmãs ainda não abertas ficam pendentes', async () => {
    const { nav, result } = await run({ changeOnBack: { x: { total: true, listing: false } } });
    expect(nav.opened()).toEqual(['p', 'x', 'q']); // Y e Z não são abertas; Q (outro pai) sim
    expect(['Y', 'Z'].map((n) => byName(result, n))).toMatchObject([
      { status: 'skipped', reasons: ['content-changed'] },
      { status: 'skipped', reasons: ['content-changed'] },
    ]);
  });

  it('sem loop de reprocessamento: a pasta afetada é lida uma única vez na sessão', async () => {
    const { nav } = await run({ changeOnBack: { x: { total: true, listing: true } } });
    expect(nav.log.filter((l) => l === 'scan:p')).toHaveLength(1);
    expect(nav.log.filter((l) => l === 'back:x')).toHaveLength(1);
  });

  it('checkpoint invalidado: subárvore afetada e ancestrais não são assentados; a retomada RÁPIDA reabre e relê', async () => {
    const first = await run({ changeOnBack: { x: { total: true, listing: true } } });
    const p = first.checkpoint.find((f) => f.reasons.includes('content-changed'))!;
    expect(isSettledSubtree(first.checkpoint, p.ref)).toBe(false);
    expect(isResumable(first.checkpoint)).toBe(true);

    const fast = await run({}, { from: first.checkpoint, mode: 'fast' });
    // Q (sem divergência) é reaproveitada; P é reaberta, e X — filha da pasta afetada — também.
    expect(fast.nav.opened()).toEqual(['p', 'x', 'y', 'z']);
    expect(fast.result.status).toBe('complete');
    expect(fast.result.verification.eligibleForPlanning).toBe(false); // rápido nunca é elegível

    const verified = await run({}, { from: first.checkpoint, mode: 'verified' });
    expect(verified.result.status).toBe('complete');
    expect(verified.result.verification.eligibleForPlanning).toBe(true);
  });

  it('falha de navegação na volta continua interrompendo (falha fechada), em categoria separada', async () => {
    const { result } = await run({ failBack: ['x'] });
    expect(result).toMatchObject({ status: 'failed', abort: { reason: 'return-failed' } });
    expect(result.navigation).toEqual({ contentChanged: 0, identityMismatch: 0, navigationFailed: 1 });
  });

  it('diagnósticos e eventos não contêm nomes, caminhos nem URLs', async () => {
    const secret = folder('root', 'BELTRANA DE TAL', [folder('p', 'REGISTRO 111.222.333-44', [folder('x', 'CICRANO'), folder('y', 'FULANA')])]);
    const nav = new SimNavigator(secret, { changeOnBack: { x: { total: true, listing: true } } });
    const events: TreeEvent[] = [];
    const r = await scanTree(nav, WIDE, { onEvent: (e) => events.push(e) });
    expect(r.navigation.contentChanged).toBe(1);
    const exposed = [...events.map(formatTreeEvent), JSON.stringify(events), JSON.stringify(diagnosticReport(r))].join('\n');
    for (const s of ['BELTRANA', '111.222', 'CICRANO', 'FULANA', 'air.test', 'my-air', '/']) expect(exposed).not.toContain(s);
    expect(exposed).toContain('content-changed');
  });
});
