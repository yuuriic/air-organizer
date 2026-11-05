import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planInventoryMovements } from '../../src/app/local-analysis.js';
import { sealInventory } from '../../src/core/inventory-integrity.js';
import {
  assessMovementProposals,
  deriveEmptyFolderPaths,
  generateMovementProposals,
  planMovements,
  redactMovementPlan,
  type MovementPlan,
  type MovementProposal,
  type MovementSelection,
} from '../../src/core/movement-planner.js';
import { planOrganization } from '../../src/core/organization-planner.js';
import { scanTree } from '../../src/core/tree-scanner.js';
import { treeInventoryDocument } from '../../src/storage/export.js';
import { inventoryAuthenticator } from '../../src/storage/integrity-key.js';
import type { AirEnvironment, TreeInventoryExport, TreeLimits } from '../../src/types/inventory.js';
import { SimNavigator, file, folder, type SimNode } from '../sim-navigator.js';

/**
 * Inventários inteiramente SINTÉTICOS (nomes fictícios, domínio .test, chave fixa de teste), gerados
 * pela leitura recursiva real sobre o simulador e selados como na exportação.
 */
const WIDE: TreeLimits = { maxDepth: 10, maxFolders: 200, maxItems: 10_000, maxPagesPerFolder: 50 };
const FINISHED = '2026-11-03T10:05:00.000Z';
const NOW = new Date('2026-11-03T12:00:00.000Z');
const KEY = Buffer.alloc(32, 7);
const AUTH = inventoryAuthenticator(KEY);
const ENV: AirEnvironment = {
  instanceOrigin: { status: 'identified', value: 'https://air.sigiloso.test', source: 'url' },
  pageUrl: { status: 'identified', value: 'https://air.sigiloso.test/air/my-air/raiz', source: 'url' },
  client: { status: 'identified', value: 'Cliente Sigiloso', source: 'operator' },
  sector: { status: 'identified', value: 'Setor Sigiloso', source: 'operator' },
  currentFolder: { status: 'identified', value: 'Raiz', source: 'page-heading' },
  breadcrumb: { status: 'not-identified', reason: 'x' },
  observedAt: FINISHED,
};

type InventoryOptions = { homonyms?: 'identify-by-url'; limits?: TreeLimits; seal?: boolean; env?: AirEnvironment };
async function inventory(root: SimNode, opts: InventoryOptions = {}): Promise<TreeInventoryExport> {
  const result = await scanTree(new SimNavigator(root), opts.limits ?? WIDE, { ...(opts.homonyms ? { homonyms: opts.homonyms } : {}) });
  const plain = treeInventoryDocument(result, { runId: 'run-sintetico', startedAt: '2026-11-03T10:00:00.000Z', finishedAt: FINISHED, environment: opts.env ?? ENV });
  return JSON.parse(JSON.stringify(opts.seal === false ? plain : sealInventory(plain, AUTH, new Date(FINISHED)))) as TreeInventoryExport;
}
/** Sela de novo depois de uma alteração: testa a regra do motor, não o selo. */
const reseal = (d: TreeInventoryExport) => JSON.parse(JSON.stringify(sealInventory(d, AUTH, new Date(FINISHED)))) as TreeInventoryExport;

const plan = (doc: unknown, selections: MovementSelection[]) => planMovements(doc, { selections }, { now: NOW, authenticator: AUTH });

const at = (p: string) => ({ path: p });
const moveFile = (parent: string, name: string, destination: string): MovementSelection => ({ kind: 'file', parent: at(parent), name, destination: at(destination) });
const moveFolder = (source: string, destination: string): MovementSelection => ({ kind: 'folder', source: at(source), destination: at(destination) });
const contents = (source: string, destination: string): MovementSelection => ({ kind: 'folder-contents', source: at(source), destination: at(destination) });

/** Proposta cuja origem tem esse caminho. */
const bySource = (p: MovementPlan, sourcePath: string): MovementProposal => {
  const found = p.proposals.filter((x) => x.source?.path === sourcePath);
  expect(found, `proposta de ${sourcePath}`).toHaveLength(1);
  return found[0]!;
};
const codes = (x: MovementProposal) => [...x.conflicts, ...x.blockers].map((i) => i.code);
const position = (p: MovementPlan, id: string) => p.proposals.findIndex((x) => x.id === id);

const baseTree = () =>
  folder('raiz', 'Raiz', [
    folder('origem', 'Origem', [
      file('f1', 'solto.pdf'),
      file('f2', 'nao-envolvido.pdf'),
      folder('o2025', '2025', [
        file('a', 'PROCESSO_00001_2025.pdf'),
        file('b', 'PROCESSO_00002_2025.pdf'),
        folder('oj', 'Janeiro', [file('c', 'ata.pdf')]),
        folder('of', 'Fevereiro', [folder('of1', 'Semana 1', [file('d', 'lista.pdf')])]),
      ]),
      folder('o2024', '2024', [file('e', 'antigo.pdf')]),
    ]),
    folder('destino', 'Destino', [
      file('g', 'existente.pdf'),
      folder('d2025', '2025', [file('h', 'PROCESSO_00009_2025.pdf'), folder('dj', 'Janeiro', [file('i', 'pauta.pdf')])]),
    ]),
    folder('outra', 'Outra', [file('j', 'intocado.pdf')]),
  ]);

describe('contrato da proposta', () => {
  it('representa origem, destino, justificativa, evidências, dependências e revisão humana', async () => {
    const p = plan(await inventory(baseTree()), [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Destino')]);
    expect(p.validation.status).toBe('accepted');
    expect(p.proposals).toHaveLength(1);
    const op = p.proposals[0]!;
    expect(op.id).toMatch(/^M-[0-9a-f]{16}$/);
    expect(op).toMatchObject({
      kind: 'move-file',
      state: 'ready-for-review',
      executable: false,
      authorizesChanges: false,
      source: { kind: 'file', name: 'solto.pdf', path: '/Raiz/Origem/solto.pdf', parentRef: expect.stringMatching(/^F\d+$/), observationKey: expect.any(String) },
      destination: { folder: { kind: 'folder', path: '/Raiz/Destino', name: 'Destino' }, resultingPath: '/Raiz/Destino/solto.pdf' },
      dependsOn: [],
      conflicts: [],
      blockers: [],
      review: { status: 'pending', required: true, decidedBy: null, decidedAt: null },
      evidence: { inventoryId: p.source.inventoryId, origin: 'operator-selection', comparison: 'metadata-only', sourceListing: { status: 'complete' }, destinationListing: { status: 'complete' } },
    });
    expect(op.justification.length).toBeGreaterThan(10);
    expect(p).toMatchObject({ kind: 'air-organizer/movement-plan', dryRun: true, executable: false, authorizesChanges: false, authenticated: false, identifiable: true });
  });

  it('distingue proposta gerada, bloqueada e apta para revisão', async () => {
    const doc = await inventory(baseTree());
    const selections = [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Destino'), moveFile('/Raiz/Origem', 'nao-envolvido.pdf', '/Raiz/Inexistente')];
    const inventoryId = plan(doc, []).source.inventoryId!;
    const generated = generateMovementProposals(doc, { selections }, inventoryId);
    expect(generated.map((x) => x.state)).toEqual(['generated', 'generated']);
    const { proposals, safeOrder } = assessMovementProposals(doc, generated);
    expect(proposals.map((x) => x.state).sort()).toEqual(['blocked', 'ready-for-review']);
    expect(generated.map((x) => x.state)).toEqual(['generated', 'generated']); // a entrada não muda
    expect(safeOrder).toEqual([proposals.find((x) => x.state === 'ready-for-review')!.id]);
    const final = plan(doc, selections);
    expect(final.summary.byState).toEqual({ generated: 0, blocked: 1, 'ready-for-review': 1 });
  });
});

describe('1. movimentação simples de arquivo', () => {
  it('uma única operação, sem criar nem mexer em mais nada', async () => {
    const p = plan(await inventory(baseTree()), [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Outra')]);
    expect(p.proposals.map((x) => x.kind)).toEqual(['move-file']);
    expect(p.safeOrder).toEqual([p.proposals[0]!.id]);
    expect(p.summary.items.involved).toBe(1);
  });

  it('pasta inteira sem correspondente no destino vai como move-folder, preservando a hierarquia', async () => {
    const p = plan(await inventory(baseTree()), [moveFolder('/Raiz/Origem/2024', '/Raiz/Destino')]);
    expect(p.proposals).toHaveLength(1);
    expect(p.proposals[0]).toMatchObject({ kind: 'move-folder', state: 'ready-for-review', destination: { resultingPath: '/Raiz/Destino/2024' }, evidence: { subtree: { folders: 0, files: 1 } } });
  });
});

describe('2 e 3. consolidação de pastas homônimas', () => {
  it('2025 na origem e no destino: consolida na existente, sem pasta duplicada', async () => {
    const p = plan(await inventory(baseTree()), [moveFolder('/Raiz/Origem/2025', '/Raiz/Destino')]);
    const top = bySource(p, '/Raiz/Origem/2025');
    expect(top).toMatchObject({ kind: 'consolidate-folder', state: 'ready-for-review', destination: { folder: { path: '/Raiz/Destino/2025' } } });
    expect(top.alerts.join(' ')).toMatch(/permanece.*nenhuma exclusão/);
    // Nenhuma operação coloca uma pasta "2025" dentro de "Destino": a existente é reaproveitada.
    expect(p.proposals.filter((x) => x.destination?.resultingPath === '/Raiz/Destino/2025')).toEqual([]);
    expect(bySource(p, '/Raiz/Origem/2025/PROCESSO_00001_2025.pdf')).toMatchObject({ kind: 'move-file', dependsOn: [top.id], parentOperation: top.id, destination: { folder: { path: '/Raiz/Destino/2025' } } });
    expect(p.summary.byState.blocked).toBe(0);
  });

  it('recursiva: subpasta correspondente consolida; sem correspondente vai inteira', async () => {
    const p = plan(await inventory(baseTree()), [moveFolder('/Raiz/Origem/2025', '/Raiz/Destino')]);
    const top = bySource(p, '/Raiz/Origem/2025');
    const janeiro = bySource(p, '/Raiz/Origem/2025/Janeiro');
    expect(janeiro).toMatchObject({ kind: 'consolidate-folder', parentOperation: top.id, destination: { folder: { path: '/Raiz/Destino/2025/Janeiro' } } });
    expect(bySource(p, '/Raiz/Origem/2025/Janeiro/ata.pdf')).toMatchObject({ kind: 'move-file', dependsOn: [janeiro.id], destination: { resultingPath: '/Raiz/Destino/2025/Janeiro/ata.pdf' } });
    // Fevereiro não existe no destino: vai inteira, e o que há dentro dela não vira operação própria.
    expect(bySource(p, '/Raiz/Origem/2025/Fevereiro')).toMatchObject({ kind: 'move-folder', parentOperation: top.id, evidence: { subtree: { folders: 1, files: 1 } } });
    expect(p.proposals.some((x) => x.source?.path?.includes('Semana 1'))).toBe(false);
  });

  it('consolidação explícita do conteúdo reúne em pasta de outro nome, escolhida pelo operador', async () => {
    const p = plan(await inventory(baseTree()), [contents('/Raiz/Origem/2024', '/Raiz/Outra')]);
    expect(bySource(p, '/Raiz/Origem/2024')).toMatchObject({ kind: 'consolidate-folder', state: 'ready-for-review', destination: { folder: { path: '/Raiz/Outra' } } });
    expect(bySource(p, '/Raiz/Origem/2024/antigo.pdf').destination?.resultingPath).toBe('/Raiz/Outra/antigo.pdf');
  });

  it('mover 2025 para dentro de outra 2025 é conflito: criaria nível repetido', async () => {
    const p = plan(await inventory(baseTree()), [moveFolder('/Raiz/Origem/2025', '/Raiz/Destino/2025')]);
    expect(codes(bySource(p, '/Raiz/Origem/2025'))).toEqual(['nested-same-name']);
    expect(p.safeOrder).toEqual([]);
  });

  it('variação de grafia nunca consolida sozinha: exige confirmação', async () => {
    const tree = folder('raiz', 'Raiz', [folder('a', 'A', [folder('x', 'ORBITAS', [file('p', 'p.pdf')])]), folder('b', 'B', [folder('y', 'Órbitas', [file('q', 'q.pdf')])])]);
    const p = plan(await inventory(tree), [moveFolder('/Raiz/A/ORBITAS', '/Raiz/B')]);
    expect(codes(bySource(p, '/Raiz/A/ORBITAS'))).toEqual(['equivalent-name-conflict']);
    expect(p.summary.byKind['consolidate-folder']).toBe(0);
    // A confirmação do operador é a consolidação explícita.
    const confirmed = plan(await inventory(tree), [contents('/Raiz/A/ORBITAS', '/Raiz/B/Órbitas')]);
    expect(bySource(confirmed, '/Raiz/A/ORBITAS')).toMatchObject({ kind: 'consolidate-folder', state: 'ready-for-review' });
  });
});

describe('4. arquivos de mesmo nome em origem e destino', () => {
  const tree = () =>
    folder('raiz', 'Raiz', [
      folder('o', 'O', [folder('o1', '2025', [file('a', 'ata.pdf'), file('b', 'lista.pdf'), file('c', 'Pauta.PDF')])]),
      folder('d', 'D', [folder('d1', '2025', [file('e', 'ata.pdf'), file('f', 'pauta.pdf')])]),
    ]);

  it('bloqueia o conflito sem presumir igualdade nem sobrescrever; o restante segue revisável', async () => {
    const p = plan(await inventory(tree()), [moveFolder('/Raiz/O/2025', '/Raiz/D')]);
    const conflict = bySource(p, '/Raiz/O/2025/ata.pdf');
    expect(conflict.state).toBe('blocked');
    expect(conflict.conflicts).toEqual([expect.objectContaining({ code: 'name-conflict', message: expect.stringMatching(/não prova mesmo conteúdo.*nada é substituído/) })]);
    expect(codes(bySource(p, '/Raiz/O/2025/Pauta.PDF'))).toEqual(['equivalent-name-conflict']);
    expect(bySource(p, '/Raiz/O/2025/lista.pdf').state).toBe('ready-for-review');
    const top = bySource(p, '/Raiz/O/2025');
    expect(top.state).toBe('ready-for-review');
    expect(top.alerts.join(' ')).toMatch(/2 operações desta consolidação estão bloqueadas.*não as libera/);
    expect(p.safeOrder).not.toContain(conflict.id);
  });

  it('arquivo selecionado direto para pasta com o mesmo nome: bloqueado', async () => {
    const p = plan(await inventory(tree()), [moveFile('/Raiz/O/2025', 'ata.pdf', '/Raiz/D/2025')]);
    expect(codes(p.proposals[0]!)).toEqual(['name-conflict']);
  });

  it('pasta contra arquivo de mesmo nome: conflito, sem consolidar', async () => {
    const t = folder('raiz', 'Raiz', [folder('o', 'O', [folder('x', 'Dados', [file('a')])]), folder('d', 'D', [file('b', 'Dados')])]);
    const p = plan(await inventory(t), [moveFolder('/Raiz/O/Dados', '/Raiz/D')]);
    expect(bySource(p, '/Raiz/O/Dados')).toMatchObject({ kind: 'move-folder', state: 'blocked' });
    expect(codes(p.proposals[0]!)).toEqual(['name-conflict']);
  });

  it('dois itens de mesmo nome indo para o mesmo destino colidem entre si', async () => {
    const t = folder('raiz', 'Raiz', [folder('a', 'A', [file('x', 'ata.pdf')]), folder('b', 'B', [file('y', 'ata.pdf')]), folder('c', 'C')]);
    const p = plan(await inventory(t), [moveFile('/Raiz/A', 'ata.pdf', '/Raiz/C'), moveFile('/Raiz/B', 'ata.pdf', '/Raiz/C')]);
    expect(p.proposals.map(codes)).toEqual([['destination-collision'], ['destination-collision']]);
    expect(p.safeOrder).toEqual([]);
  });

  it('duas pastas de mesmo nome para o mesmo destino não criam pastas duplicadas', async () => {
    const t = folder('raiz', 'Raiz', [folder('a', 'A', [folder('x', '2025', [file('p')])]), folder('b', 'B', [folder('y', '2025', [file('q')])]), folder('c', 'C')]);
    const p = plan(await inventory(t), [moveFolder('/Raiz/A/2025', '/Raiz/C'), moveFolder('/Raiz/B/2025', '/Raiz/C')]);
    expect(p.proposals.map(codes)).toEqual([['destination-collision'], ['destination-collision']]);
  });
});

describe('semântica da consolidação: agrupamento lógico, que não libera operações', () => {
  const group = (p: MovementPlan, sourcePath: string) => bySource(p, sourcePath).group!;

  it('todas aptas: all-ready, com as operações de todos os níveis', async () => {
    const p = plan(await inventory(baseTree()), [moveFolder('/Raiz/Origem/2025', '/Raiz/Destino')]);
    const top = bySource(p, '/Raiz/Origem/2025');
    expect(top.group).toMatchObject({ status: 'all-ready', authorizesOperations: false, blockedOperations: [] });
    expect([...top.group!.readyOperations].sort()).toEqual(p.proposals.filter((x) => x !== top).map((x) => x.id).sort());
    expect(p.summary.consolidations).toEqual({ 'all-ready': 2, 'partially-blocked': 0, 'fully-blocked': 0, empty: 0 });
  });

  it('parcialmente bloqueada: não libera a filha bloqueada, que fica fora da ordem segura', async () => {
    const t = folder('raiz', 'Raiz', [folder('o', 'O', [folder('o1', '2025', [file('a', 'ata.pdf'), file('b', 'lista.pdf')])]), folder('d', 'D', [folder('d1', '2025', [file('e', 'ata.pdf')])])]);
    const p = plan(await inventory(t), [moveFolder('/Raiz/O/2025', '/Raiz/D')]);
    const top = bySource(p, '/Raiz/O/2025');
    const blocked = bySource(p, '/Raiz/O/2025/ata.pdf');
    const ready = bySource(p, '/Raiz/O/2025/lista.pdf');
    expect(top.state).toBe('ready-for-review');
    expect(top.group).toEqual({ status: 'partially-blocked', authorizesOperations: false, readyOperations: [ready.id], blockedOperations: [blocked.id] });
    expect(blocked.state).toBe('blocked');
    expect(p.safeOrder).toEqual([top.id, ready.id]);
    expect(p.safeOrder).not.toContain(blocked.id);
    // A revisão é de cada operação: nada na consolidação decide pelas filhas.
    for (const x of p.proposals) expect(x).toMatchObject({ executable: false, authorizesChanges: false, review: { status: 'pending', decidedBy: null } });
  });

  it('totalmente bloqueada: a consolidação fica bloqueada e sai da ordem segura', async () => {
    const t = folder('raiz', 'Raiz', [folder('o', 'O', [folder('o1', '2025', [file('a', 'ata.pdf'), file('b', 'lista.pdf')])]), folder('d', 'D', [folder('d1', '2025', [file('e', 'ata.pdf'), file('f', 'LISTA.pdf')])])]);
    const p = plan(await inventory(t), [moveFolder('/Raiz/O/2025', '/Raiz/D')]);
    const top = bySource(p, '/Raiz/O/2025');
    expect(top).toMatchObject({ state: 'blocked', group: { status: 'fully-blocked', authorizesOperations: false, readyOperations: [] } });
    expect(top.group!.blockedOperations).toHaveLength(2);
    expect(codes(top)).toEqual(['no-ready-operations']);
    expect(p.safeOrder).toEqual([]);
    expect(p.summary.consolidations['fully-blocked']).toBe(1);
  });

  it('consolidação interna totalmente bloqueada torna a externa parcial', async () => {
    const t = folder('raiz', 'Raiz', [
      folder('o', 'O', [folder('o1', '2025', [file('b', 'livre.pdf'), folder('oj', 'Janeiro', [file('a', 'ata.pdf')])])]),
      folder('d', 'D', [folder('d1', '2025', [folder('dj', 'Janeiro', [file('e', 'ata.pdf')])])]),
    ]);
    const p = plan(await inventory(t), [moveFolder('/Raiz/O/2025', '/Raiz/D')]);
    expect(group(p, '/Raiz/O/2025/Janeiro').status).toBe('fully-blocked');
    expect(bySource(p, '/Raiz/O/2025/Janeiro').state).toBe('blocked');
    expect(group(p, '/Raiz/O/2025').status).toBe('partially-blocked');
    expect(p.safeOrder).toEqual([bySource(p, '/Raiz/O/2025').id, bySource(p, '/Raiz/O/2025/livre.pdf').id]);
  });

  it('impedimento da própria consolidação bloqueia todas as filhas, em qualquer nível', async () => {
    const t = folder('raiz', 'Raiz', [folder('o', 'O', [file('a', 'a.pdf'), folder('o1', 'Y', [file('b', 'b.pdf')])]), folder('d', 'D', [folder('d1', 'Y')]), folder('x', 'X')]);
    // A mesma origem pedida em duas consolidações: conflito na de cima, que precisa alcançar as filhas.
    const p = plan(await inventory(t), [contents('/Raiz/O', '/Raiz/D'), contents('/Raiz/O', '/Raiz/X')]);
    expect(p.proposals.length).toBeGreaterThan(2);
    for (const x of p.proposals) expect(x.state).toBe('blocked');
    expect(p.safeOrder).toEqual([]);
    for (const x of p.proposals.filter((o) => o.kind === 'consolidate-folder')) expect(x.group!.status).toBe('fully-blocked');
  });

  it('origem vazia: empty, sem presumir que algo será consolidado', async () => {
    const t = folder('raiz', 'Raiz', [folder('o', 'O', [folder('o1', '2025')]), folder('d', 'D', [folder('d1', '2025', [file('e', 'ata.pdf')])])]);
    const p = plan(await inventory(t), [moveFolder('/Raiz/O/2025', '/Raiz/D')]);
    expect(bySource(p, '/Raiz/O/2025')).toMatchObject({ state: 'ready-for-review', group: { status: 'empty', readyOperations: [], blockedOperations: [] } });
    expect(bySource(p, '/Raiz/O/2025').alerts.join(' ')).toMatch(/não tem o que consolidar/);
  });

  it('a consolidação em si não conta como item movido: a pasta de origem permanece', async () => {
    const p = plan(await inventory(baseTree()), [contents('/Raiz/Origem/2024', '/Raiz/Outra')]);
    expect(p.summary.items.involved).toBe(1); // só o arquivo: a pasta de origem permanece
    expect(p.notices.join(' ')).toMatch(/só agrupa operações: não aprova nem libera/);
  });
});

describe('caminho derivado de subpasta vazia', () => {
  /** Como a leitura real grava uma subpasta vazia: sem linhas, sem coluna "Caminho". */
  const tree = (extra: SimNode[] = []) => folder('raiz', 'Raiz', [folder('o', 'Origem', [file('f', 'solto.pdf')]), folder('v', 'Vazia'), ...extra]);
  const at_ = (d: TreeInventoryExport, ref: string) => d.folders.find((f) => f.ref === ref)!;
  const refOf = (d: TreeInventoryExport, p: string) => d.folders.find((f) => f.path === p)!.ref;
  const withoutPath = (d: TreeInventoryExport, ...paths: string[]) => {
    const refs = paths.map((p) => refOf(d, p));
    for (const ref of refs) delete at_(d, ref).path;
    return refs;
  };
  const moveToEmpty = moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Vazia');

  describe('derivação aceita', () => {
    it('destino vazio: proposta apta, com a proveniência e o alerta registrados', async () => {
      const d = await inventory(tree());
      const [ref] = withoutPath(d, '/Raiz/Vazia');
      const sealed = reseal(d);
      expect(deriveEmptyFolderPaths(sealed)).toEqual({ derived: new Map([[ref, '/Raiz/Vazia']]), refused: new Map() });
      const op = plan(sealed, [moveToEmpty]).proposals[0]!;
      expect(op).toMatchObject({ state: 'ready-for-review', executable: false, destination: { folder: { ref, path: '/Raiz/Vazia', pathProvenance: 'derived-from-parent' }, resultingPath: '/Raiz/Vazia/solto.pdf' } });
      expect(op.alerts.join(' ')).toMatch(/derivado do pai e do nome.*reconfirme/);
    });

    it('caminho gravado continua como observado, sem alerta', async () => {
      const op = plan(await inventory(tree()), [moveToEmpty]).proposals[0]!;
      expect(op.destination!.folder.pathProvenance).toBe('observed');
      expect(op.alerts).toEqual([]);
    });

    it('origem vazia também é identificada', async () => {
      const d = await inventory(tree([folder('x', 'Destino')]));
      withoutPath(d, '/Raiz/Vazia');
      const op = plan(reseal(d), [moveFolder('/Raiz/Vazia', '/Raiz/Destino')]).proposals[0]!;
      expect(op).toMatchObject({ kind: 'move-folder', state: 'ready-for-review', source: { pathProvenance: 'derived-from-parent' } });
    });

    it('consolidação reaproveita a homônima vazia, sem criar outra pasta', async () => {
      const t = folder('raiz', 'Raiz', [folder('o', 'O', [folder('o1', '2025', [file('a', 'ata.pdf')])]), folder('d', 'D', [folder('d1', '2025')])]);
      const d = await inventory(t);
      withoutPath(d, '/Raiz/D/2025');
      const p = plan(reseal(d), [moveFolder('/Raiz/O/2025', '/Raiz/D')]);
      expect(bySource(p, '/Raiz/O/2025')).toMatchObject({ kind: 'consolidate-folder', state: 'ready-for-review', destination: { folder: { path: '/Raiz/D/2025', pathProvenance: 'derived-from-parent' } } });
      expect(bySource(p, '/Raiz/O/2025/ata.pdf').state).toBe('ready-for-review');
    });

    it('não altera o inventário, o selo nem a elegibilidade; é determinística e sai redigida', async () => {
      const d = await inventory(tree());
      withoutPath(d, '/Raiz/Vazia');
      const sealed = reseal(d);
      const before = JSON.stringify(sealed);
      const p = plan(sealed, [moveToEmpty]);
      expect(JSON.stringify(sealed)).toBe(before);
      expect(JSON.stringify(plan(sealed, [moveToEmpty]))).toBe(JSON.stringify(p));
      expect(sealed.folders.some((f) => f.path === undefined)).toBe(true);
      expect(p.validation).toEqual(planOrganization(sealed, { now: NOW, authenticator: AUTH }).validation);
      const redacted = JSON.stringify(redactMovementPlan(p));
      expect(redacted).toContain('derived-from-parent');
      expect(redacted).not.toContain('Vazia');
    });
  });

  describe('derivação recusada: bloqueio conservador', () => {
    /** O motivo da recusa e o bloqueio da seleção pelo caminho que a pasta teria. */
    const expectRefused = (d: TreeInventoryExport, ref: string, reason: string, code: string, selection = moveToEmpty) => {
      const sealed = reseal(d);
      expect(deriveEmptyFolderPaths(sealed).refused.get(ref)).toBe(reason);
      expect(deriveEmptyFolderPaths(sealed).derived.has(ref)).toBe(false);
      const op = plan(sealed, [selection]).proposals[0]!;
      expect(op.state).toBe('blocked');
      expect(op.blockers.map((b) => b.code)).toContain(code);
      expect(op.destination).toBeUndefined();
      expect(plan(sealed, [selection]).safeOrder).toEqual([]);
    };

    it('caminho construído sem pasta no inventário não prova existência', async () => {
      const d = await inventory(tree());
      withoutPath(d, '/Raiz/Vazia');
      const op = plan(reseal(d), [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Inventada')]).proposals[0]!;
      expect(op.blockers.map((b) => b.code)).toEqual(['destination-not-found']);
    });

    it('caminho construído sobre pasta vazia inexistente, abaixo de pai real', async () => {
      const d = await inventory(tree());
      const op = plan(d, [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Vazia/Filha')]).proposals[0]!;
      expect(op.blockers.map((b) => b.code)).toEqual(['destination-not-found']);
    });

    it('pasta não vazia sem caminho', async () => {
      const d = await inventory(tree());
      const [ref] = withoutPath(d, '/Raiz/Origem');
      expect(deriveEmptyFolderPaths(reseal(d)).refused.get(ref!)).toBe('not-empty');
      expect(plan(reseal(d), [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Vazia')]).proposals[0]!.state).toBe('blocked');
    });

    it('pai sem caminho: nem chega a haver caminho a selecionar', async () => {
      const t = folder('raiz', 'Raiz', [folder('o', 'Origem', [file('f', 'solto.pdf')]), folder('p', 'Pai', [folder('v', 'Vazia')])]);
      const d = await inventory(t);
      const paiRef = refOf(d, '/Raiz/Pai');
      const [ref] = withoutPath(d, '/Raiz/Pai/Vazia');
      delete at_(d, paiRef).path;
      const sealed = reseal(d);
      expect(deriveEmptyFolderPaths(sealed).refused.get(ref!)).toBe('parent-unknown');
      expect(plan(sealed, [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Pai/Vazia')]).proposals[0]!.blockers.map((b) => b.code)).toEqual(['destination-not-found']);
    });

    it('sem URL observada, ou com URL de outra pasta', async () => {
      const a = await inventory(tree());
      const [ra] = withoutPath(a, '/Raiz/Vazia');
      delete at_(a, ra!).pageUrl;
      expectRefused(a, ra!, 'no-navigation-evidence', 'insufficient-data');

      const b = await inventory(tree());
      const origem = b.folders.find((f) => f.path === '/Raiz/Origem')!;
      const [rb] = withoutPath(b, '/Raiz/Vazia');
      at_(b, rb!).pageUrl = origem.pageUrl!;
      expectRefused(b, rb!, 'no-navigation-evidence', 'insufficient-data');
    });

    it('homônimo no caminho do pai', async () => {
      const t = folder('raiz', 'Raiz', [folder('o', 'Origem', [file('f', 'solto.pdf')]), folder('a', 'Dup', [folder('v', 'Vazia')]), folder('b', 'Dup')]);
      const d = await inventory(t, { homonyms: 'identify-by-url' });
      const [ref] = withoutPath(d, '/Raiz/Dup/Vazia');
      expectRefused(d, ref!, 'parent-ambiguous', 'ambiguous-destination', moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Dup/Vazia'));
    });

    it('irmãs homônimas vazias: ambíguo, sem desempate', async () => {
      const d = await inventory(tree([folder('w', 'Vazia')]), { homonyms: 'identify-by-url' });
      const refs = d.folders.filter((f) => f.path === '/Raiz/Vazia').map((f) => f.ref);
      expect(refs).toHaveLength(2);
      for (const ref of refs) delete at_(d, ref).path;
      expectRefused(d, refs[0]!, 'sibling-ambiguous', 'ambiguous-destination');
      expect(deriveEmptyFolderPaths(reseal(d)).refused.get(refs[1]!)).toBe('sibling-ambiguous');
    });

    it('irmão com nome equivalente após normalização', async () => {
      const d = await inventory(tree([folder('w', 'VAZIA')]));
      const [ref] = withoutPath(d, '/Raiz/Vazia');
      expectRefused(d, ref!, 'sibling-ambiguous', 'ambiguous-destination');
    });

    it('arquivo irmão com nome equivalente', async () => {
      const d = await inventory(tree([file('z', 'Vazia.')]));
      const [ref] = withoutPath(d, '/Raiz/Vazia');
      expectRefused(d, ref!, 'sibling-ambiguous', 'ambiguous-destination');
    });

    it('linha do pai sem evidência ou apontando para outro ramo', async () => {
      const a = await inventory(tree());
      const [ra] = withoutPath(a, '/Raiz/Vazia');
      a.folders.find((f) => !f.parentRef)!.items.find((i) => i.name === 'Vazia')!.identityConfidence = 'ambiguous';
      expectRefused(a, ra!, 'row-unconfirmed', 'insufficient-data');

      const b = await inventory(tree());
      const [rb] = withoutPath(b, '/Raiz/Vazia');
      b.folders.find((f) => !f.parentRef)!.items.find((i) => i.name === 'Vazia')!.path = '/Raiz/Outro';
      expectRefused(b, rb!, 'row-unconfirmed', 'insufficient-data');

      const c = await inventory(tree());
      const [rc] = withoutPath(c, '/Raiz/Vazia');
      delete c.folders.find((f) => !f.parentRef)!.items.find((i) => i.name === 'Vazia')!.path;
      expectRefused(c, rc!, 'row-unconfirmed', 'insufficient-data');
    });

    it('nome que não pode compor um caminho, ou caminho que já é de outra pasta', async () => {
      const a = await inventory(tree([folder('s', 'Com/Barra')]));
      const [ra] = withoutPath(a, '/Raiz/Com/Barra');
      const sealedA = reseal(a);
      expect(deriveEmptyFolderPaths(sealedA).refused.get(ra!)).toBe('unsafe-name');
      expect(plan(sealedA, [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Com/Barra')]).proposals[0]!.blockers.map((b) => b.code)).toEqual(['insufficient-data']);

      const b = await inventory(tree());
      const [rb] = withoutPath(b, '/Raiz/Vazia');
      b.folders.find((f) => f.path === '/Raiz/Origem')!.path = '/Raiz/Vazia';
      for (const item of b.folders.find((f) => f.path === '/Raiz/Vazia')!.items) item.path = '/Raiz/Vazia';
      expect(deriveEmptyFolderPaths(reseal(b)).refused.get(rb!)).toBe('path-collision');
    });

    it('leitura da pasta não confirmada: recusa na derivação e inventário recusado', async () => {
      const d = await inventory(tree());
      const [ref] = withoutPath(d, '/Raiz/Vazia');
      at_(d, ref!).status = 'partial';
      expect(deriveEmptyFolderPaths(d).refused.get(ref!)).toBe('not-confirmed');
      expect(plan(reseal(d), [moveToEmpty]).validation.status).toBe('refused');
    });

    it('pasta inicial nunca é derivada; mensagens não têm nomes', async () => {
      const d = await inventory(tree());
      const root = d.folders.find((f) => !f.parentRef)!;
      delete root.path;
      const refused = deriveEmptyFolderPaths(reseal(d)).refused;
      expect(refused.get(root.ref)).toBe('no-parent');

      const e = await inventory(tree([folder('w', 'VAZIA')]));
      withoutPath(e, '/Raiz/Vazia');
      const op = plan(reseal(e), [moveToEmpty]).proposals[0]!;
      expect(op.blockers[0]!.message).not.toMatch(/Vazia|VAZIA/);
    });
  });
});

describe('5. destino inexistente', () => {
  it('bloqueia sem criar pasta implicitamente', async () => {
    const p = plan(await inventory(baseTree()), [moveFolder('/Raiz/Origem/2024', '/Raiz/Nova')]);
    const op = p.proposals[0]!;
    expect(op).toMatchObject({ state: 'blocked', requested: { kind: 'folder' } });
    expect(op.destination).toBeUndefined();
    expect(op.blockers[0]).toMatchObject({ code: 'destination-not-found', message: expect.stringMatching(/Nenhuma pasta é criada/) });
  });

  it('grafia aproximada não resolve o destino: só avisa que há caminho equivalente', async () => {
    const p = plan(await inventory(baseTree()), [moveFile('/Raiz/Origem', 'solto.pdf', '/raiz/DESTINO')]);
    expect(p.proposals[0]!.blockers[0]).toMatchObject({ code: 'destination-not-found', message: expect.stringMatching(/1 caminho é equivalente/) });
  });

  it('origem inexistente também bloqueia', async () => {
    const p = plan(await inventory(baseTree()), [moveFile('/Raiz/Origem', 'nao-existe.pdf', '/Raiz/Outra'), moveFolder('/Raiz/Nada', '/Raiz/Outra')]);
    expect(p.proposals.map((x) => x.blockers[0]!.code)).toEqual(['source-not-found', 'source-not-found']);
  });
});

describe('6. origem ou destino ambíguo', () => {
  const homonyms = () =>
    folder('raiz', 'Raiz', [
      folder('h1', 'Duplicada', [file('a', 'a.pdf'), folder('n', 'Interna')]),
      folder('h2', 'Duplicada', [file('b', 'b.pdf')]),
      folder('o', 'Origem', [file('c', 'c.pdf'), { id: 'd1', name: 'igual.pdf', type: 'file', createdAt: '01/01/2024' }, { id: 'd2', name: 'igual.pdf', type: 'file', createdAt: '02/01/2024' }]),
    ]);
  const doc = () => inventory(homonyms(), { homonyms: 'identify-by-url' });

  it('destino homônimo bloqueia, mesmo informando a referência', async () => {
    const d = await doc();
    expect(plan(d, []).validation.status).toBe('accepted');
    const ref = d.folders.find((f) => f.path === '/Raiz/Duplicada')!.ref;
    const p = plan(d, [moveFile('/Raiz/Origem', 'c.pdf', '/Raiz/Duplicada'), { kind: 'file', parent: at('/Raiz/Origem'), name: 'c.pdf', destination: { path: '/Raiz/Duplicada', ref } }]);
    for (const op of p.proposals) expect(op.blockers.map((b) => b.code)).toEqual(['ambiguous-destination']);
  });

  it('origem homônima bloqueia', async () => {
    const p = plan(await doc(), [moveFolder('/Raiz/Duplicada', '/Raiz/Origem')]);
    expect(p.proposals[0]!.blockers.map((b) => b.code)).toEqual(['ambiguous-source']);
  });

  it('caminho único abaixo de homônimos continua ambíguo', async () => {
    const p = plan(await doc(), [moveFolder('/Raiz/Duplicada/Interna', '/Raiz/Origem')]);
    expect(codes(bySource(p, '/Raiz/Duplicada/Interna'))).toContain('ambiguous-source');
  });

  it('dois arquivos de mesmo nome na pasta: nome não distingue qual mover', async () => {
    const p = plan(await doc(), [moveFile('/Raiz/Origem', 'igual.pdf', '/Raiz')]);
    expect(p.proposals[0]!.blockers.map((b) => b.code)).toEqual(['ambiguous-source']);
    expect(p.proposals[0]!.source).toBeUndefined();
  });

  it('subpasta correspondente duplicada no destino bloqueia a consolidação', async () => {
    const t = folder('raiz', 'Raiz', [folder('o', 'O', [folder('x', 'Duplicada', [file('a')])]), folder('d', 'D', [folder('p', 'Duplicada'), folder('q', 'Duplicada')])]);
    const p = plan(await inventory(t, { homonyms: 'identify-by-url' }), [moveFolder('/Raiz/O/Duplicada', '/Raiz/D')]);
    expect(p.proposals).toHaveLength(1);
    expect(codes(p.proposals[0]!)).toEqual(['ambiguous-destination']);
  });
});

describe('7. inventário parcial ou sem integridade comprovada', () => {
  const selections = [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Outra')];
  const expectRefused = (p: MovementPlan) => {
    expect(p.validation.status).toBe('refused');
    expect(p.validation.reasons.length).toBeGreaterThan(0);
    expect(p.proposals).toEqual([]);
    expect(p.safeOrder).toEqual([]);
    expect(p.source).toEqual({});
    expect(p.identifiable).toBe(false);
    expect(p.summary.selections).toBe(1);
  };

  it('leitura parcial (limite atingido): recusado, sem propostas', async () => {
    expectRefused(plan(await inventory(baseTree(), { limits: { ...WIDE, maxDepth: 1 } }), selections));
  });

  it('homônimos não abertos: recusado', async () => {
    const t = folder('raiz', 'Raiz', [folder('a', 'Igual'), folder('b', 'Igual'), folder('origem', 'Origem', [file('f1', 'solto.pdf')]), folder('outra', 'Outra')]);
    expectRefused(plan(await inventory(t), selections));
  });

  it('sem selo, selo adulterado, sem chave ou antigo: recusado', async () => {
    const sealed = await inventory(baseTree());
    expectRefused(plan(await inventory(baseTree(), { seal: false }), selections));
    expectRefused(plan({ ...sealed, runId: 'adulterado' }, selections));
    expectRefused(planMovements(sealed, { selections }, { now: NOW }));
    expectRefused(planMovements(sealed, { selections }, { now: new Date('2026-12-30T00:00:00.000Z'), authenticator: AUTH }));
    expectRefused(plan({ not: 'inventory' }, selections));
  });

  it('elegibilidade igual à do planejamento de organização', async () => {
    const partial = await inventory(baseTree(), { limits: { ...WIDE, maxDepth: 1 } });
    expect(plan(partial, selections).validation).toEqual(planOrganization(partial, { now: NOW, authenticator: AUTH }).validation);
  });

  it('setor não identificado bloqueia toda proposta', async () => {
    const d = await inventory(baseTree(), { env: { ...ENV, sector: { status: 'not-identified', reason: 'x' } } });
    const p = plan(d, selections);
    expect(p.validation.status).toBe('accepted');
    expect(codes(p.proposals[0]!)).toEqual(['sector-not-identified']);
    expect(p.safeOrder).toEqual([]);
  });
});

describe('8. identidade de item inconsistente', () => {
  const doc = () => inventory(baseTree());
  const folderAt = (d: TreeInventoryExport, p: string) => d.folders.find((f) => f.path === p)!;

  it('referência que não corresponde ao caminho bloqueia', async () => {
    const d = await doc();
    const wrong = folderAt(d, '/Raiz/Outra').ref;
    const p = plan(d, [{ kind: 'file', parent: { path: '/Raiz/Origem', ref: wrong }, name: 'solto.pdf', destination: at('/Raiz/Destino') }, { kind: 'file', parent: { path: '/Raiz/Sumiu', ref: wrong }, name: 'solto.pdf', destination: at('/Raiz/Destino') }]);
    expect(p.proposals.map((x) => x.blockers[0]!.code)).toEqual(['identity-inconsistent', 'identity-inconsistent']);
  });

  it('selecionar pasta como arquivo bloqueia', async () => {
    const p = plan(await doc(), [moveFile('/Raiz/Origem', '2024', '/Raiz/Outra')]);
    expect(p.proposals[0]!.blockers.map((b) => b.code)).toEqual(['identity-inconsistent']);
  });

  it('arquivo com "Caminho" de outro ramo bloqueia', async () => {
    const d = await doc();
    folderAt(d, '/Raiz/Origem').items.find((i) => i.name === 'solto.pdf')!.path = '/Raiz/Outro/Ramo';
    expect(plan(reseal(d), [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Outra')]).proposals[0]!.blockers.map((b) => b.code)).toEqual(['identity-inconsistent']);
  });

  it('arquivo sem evidência de identidade bloqueia', async () => {
    const d = await doc();
    const item = folderAt(d, '/Raiz/Origem').items.find((i) => i.name === 'solto.pdf')!;
    item.identityConfidence = 'ambiguous';
    expect(plan(reseal(d), [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Outra')]).proposals[0]!.blockers.map((b) => b.code)).toEqual(['ambiguous-source']);
  });

  it('assinatura de observação repetida na pasta bloqueia', async () => {
    const d = await doc();
    const items = folderAt(d, '/Raiz/Origem').items;
    items.find((i) => i.name === 'solto.pdf')!.observationKey = items.find((i) => i.name === 'nao-envolvido.pdf')!.observationKey;
    expect(codes(plan(reseal(d), [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Outra')]).proposals[0]!)).toContain('identity-inconsistent');
  });

  it('duas pastas com a mesma URL observada bloqueiam', async () => {
    const d = await doc();
    folderAt(d, '/Raiz/Outra').pageUrl = folderAt(d, '/Raiz/Origem').pageUrl!;
    expect(codes(plan(reseal(d), [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Outra')]).proposals[0]!)).toContain('identity-inconsistent');
  });

  it('pasta sem URL observada: dados insuficientes', async () => {
    const d = await doc();
    delete folderAt(d, '/Raiz/Outra').pageUrl;
    expect(codes(plan(reseal(d), [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Outra')]).proposals[0]!)).toEqual(['insufficient-data']);
  });

  it('item de tipo desconhecido não é tratado como arquivo e bloqueia consolidação e pasta que o carrega', async () => {
    const d = await doc();
    const origem = folderAt(d, '/Raiz/Origem');
    origem.items.find((i) => i.name === 'solto.pdf')!.kind = 'unknown';
    origem.counts.files--;
    origem.counts.unknown++;
    const sealed = reseal(d);
    expect(plan(sealed, [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Outra')]).proposals[0]!.blockers.map((b) => b.code)).toEqual(['unknown-item']);
    expect(codes(plan(sealed, [moveFolder('/Raiz/Origem', '/Raiz/Outra')]).proposals[0]!)).toContain('unknown-item');
    expect(codes(bySource(plan(sealed, [contents('/Raiz/Origem', '/Raiz/Outra')]), '/Raiz/Origem'))).toEqual(['unknown-item']);
  });

  it('seleção malformada bloqueia em vez de lançar erro', async () => {
    const p = plan(await doc(), [{ kind: 'delete', source: at('/Raiz/Origem') } as unknown as MovementSelection, null as unknown as MovementSelection]);
    expect(p.proposals.map((x) => x.blockers[0]!.code)).toEqual(['invalid-selection', 'invalid-selection']);
    expect(p.safeOrder).toEqual([]);
  });

  it('pedido sem lista de seleções é erro do chamador', async () => {
    expect(() => planMovements(null, {} as never, { now: NOW })).toThrow(TypeError);
  });
});

describe('9. dependências e ordenação', () => {
  it('consolidação vem antes das operações derivadas, em todos os níveis', async () => {
    const p = plan(await inventory(baseTree()), [moveFolder('/Raiz/Origem/2025', '/Raiz/Destino')]);
    for (const op of p.proposals) for (const dep of op.dependsOn) expect(position(p, dep)).toBeLessThan(position(p, op.id));
    expect(p.safeOrder).toEqual(p.proposals.map((x) => x.id));
  });

  it('retirar item de pasta que será movida vem antes de mover a pasta', async () => {
    const p = plan(await inventory(baseTree()), [moveFolder('/Raiz/Origem/2024', '/Raiz/Outra'), moveFile('/Raiz/Origem/2024', 'antigo.pdf', '/Raiz/Destino')]);
    const mover = bySource(p, '/Raiz/Origem/2024');
    const file_ = bySource(p, '/Raiz/Origem/2024/antigo.pdf');
    expect(mover.dependsOn).toEqual([file_.id]);
    expect(p.safeOrder).toEqual([file_.id, mover.id]);
  });

  it('levar item para pasta que será movida vem antes de mover a pasta', async () => {
    const p = plan(await inventory(baseTree()), [moveFolder('/Raiz/Origem/2024', '/Raiz/Outra'), moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Origem/2024')]);
    const mover = bySource(p, '/Raiz/Origem/2024');
    const file_ = bySource(p, '/Raiz/Origem/solto.pdf');
    expect(mover.dependsOn).toEqual([file_.id]);
    expect(p.safeOrder).toEqual([file_.id, mover.id]);
  });

  it('bloqueio propaga para quem depende: a pasta não é movida com o arquivo que deveria sair antes', async () => {
    const p = plan(await inventory(baseTree()), [moveFolder('/Raiz/Origem/2024', '/Raiz/Outra'), moveFile('/Raiz/Origem/2024', 'antigo.pdf', '/Raiz/Nada')]);
    const blockedFile = bySource(p, '/Raiz/Origem/2024/antigo.pdf');
    expect(blockedFile.blockers.map((b) => b.code)).toEqual(['destination-not-found']);
    expect(bySource(p, '/Raiz/Origem/2024').blockers).toEqual([expect.objectContaining({ code: 'dependency-blocked', relatedOperations: [blockedFile.id] })]);
    expect(p.safeOrder).toEqual([]);
  });

  it('a mesma origem em duas operações: as duas bloqueadas, referenciando uma à outra', async () => {
    const p = plan(await inventory(baseTree()), [moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Outra'), moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Destino')]);
    const [a, b] = p.proposals;
    expect(a!.conflicts[0]).toMatchObject({ code: 'source-claimed-twice', relatedOperations: [b!.id] });
    expect(b!.conflicts[0]).toMatchObject({ code: 'source-claimed-twice', relatedOperations: [a!.id] });
  });

  it('o mesmo pedido repetido vira uma só operação', async () => {
    const op = moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Outra');
    const p = plan(await inventory(baseTree()), [op, op]);
    expect(p.proposals).toHaveLength(1);
    expect(p.proposals[0]!.state).toBe('ready-for-review');
  });
});

describe('10. prevenção de ciclos', () => {
  const tree = () => folder('raiz', 'Raiz', [folder('a', 'A', [folder('a1', 'A1')]), folder('b', 'B'), folder('c', 'C')]);

  it('pasta para si mesma ou para descendente', async () => {
    const p = plan(await inventory(tree()), [moveFolder('/Raiz/A', '/Raiz/A'), moveFolder('/Raiz/A', '/Raiz/A/A1')]);
    for (const op of p.proposals) expect(codes(op)).toContain('move-into-self');
    expect(p.safeOrder).toEqual([]);
  });

  it('pasta inicial nunca é movida', async () => {
    const p = plan(await inventory(tree()), [moveFolder('/Raiz', '/Raiz/B')]);
    expect(codes(p.proposals[0]!)).toEqual(expect.arrayContaining(['root-move', 'move-into-self']));
  });

  it('consolidação com pasta que contém a outra', async () => {
    const t = folder('raiz', 'Raiz', [folder('x', '2025', [folder('y', '2025', [folder('z', '2025', [file('f')])])])]);
    const p = plan(await inventory(t), [contents('/Raiz/2025', '/Raiz/2025/2025'), contents('/Raiz/2025/2025', '/Raiz/2025'), contents('/Raiz/2025', '/Raiz/2025'), moveFolder('/Raiz/2025/2025/2025', '/Raiz/2025')]);
    for (const op of p.proposals) expect(op.state).toBe('blocked');
    expect(p.proposals.filter((x) => x.kind === 'move-file')).toEqual([]);
    expect(p.proposals.some((x) => codes(x).includes('overlapping-consolidation'))).toBe(true);
  });

  it('troca entre duas pastas e ciclo longo: bloqueados, sem ordem segura', async () => {
    const swap = plan(await inventory(tree()), [moveFolder('/Raiz/A', '/Raiz/B'), moveFolder('/Raiz/B', '/Raiz/A')]);
    for (const op of swap.proposals) expect(codes(op)).toContain('dependency-cycle');
    expect(swap.proposals).toHaveLength(2);
    expect(swap.safeOrder).toEqual([]);

    const long = plan(await inventory(tree()), [moveFolder('/Raiz/A', '/Raiz/B'), moveFolder('/Raiz/B', '/Raiz/C'), moveFolder('/Raiz/C', '/Raiz/A')]);
    for (const op of long.proposals) expect(codes(op)).toContain('dependency-cycle');
    expect(long.safeOrder).toEqual([]);
  });

  it('quem só depende do ciclo é bloqueado por dependência, não marcado como ciclo; o resto segue', async () => {
    const t = folder('raiz', 'Raiz', [folder('p', 'P', [folder('a', 'A'), folder('b', 'B')]), folder('n', 'N', [file('f', 'livre.pdf')]), folder('o', 'O')]);
    const p = plan(await inventory(t), [moveFolder('/Raiz/P/A', '/Raiz/P/B'), moveFolder('/Raiz/P/B', '/Raiz/P/A'), moveFolder('/Raiz/P', '/Raiz/O'), moveFile('/Raiz/N', 'livre.pdf', '/Raiz/O')]);
    expect(codes(bySource(p, '/Raiz/P/A'))).toEqual(['dependency-cycle']);
    expect(codes(bySource(p, '/Raiz/P/B'))).toEqual(['dependency-cycle']);
    expect(codes(bySource(p, '/Raiz/P'))).toEqual(['dependency-blocked']);
    expect(p.safeOrder).toEqual([bySource(p, '/Raiz/N/livre.pdf').id]);
  });

  it('operação da qual o ciclo depende, mas que não faz parte dele, segue revisável', async () => {
    const t = folder('raiz', 'Raiz', [folder('a', 'A'), folder('b', 'B'), folder('m', 'M')]);
    const p = plan(await inventory(t), [moveFolder('/Raiz/A', '/Raiz/B'), moveFolder('/Raiz/B', '/Raiz/A'), moveFolder('/Raiz/M', '/Raiz/A')]);
    expect(codes(bySource(p, '/Raiz/A'))).toEqual(['dependency-cycle']);
    expect(bySource(p, '/Raiz/M').state).toBe('ready-for-review');
  });
});

describe('11. preservação de arquivos não envolvidos', () => {
  it('nada fora da seleção aparece no plano, e a contagem confere', async () => {
    const d = await inventory(baseTree());
    const p = plan(d, [moveFolder('/Raiz/Origem/2025', '/Raiz/Destino')]);
    const text = JSON.stringify(p.proposals);
    for (const untouched of ['nao-envolvido.pdf', 'solto.pdf', 'intocado.pdf', 'existente.pdf', 'antigo.pdf', 'PROCESSO_00009_2025.pdf', 'pauta.pdf']) expect(text).not.toContain(untouched);
    // 2 arquivos da pasta, ata.pdf, e Fevereiro inteira (a linha, Semana 1, lista.pdf).
    expect(p.summary.items).toEqual({ inventory: d.folders.reduce((n, f) => n + f.items.length, 0), involved: 6, notInvolved: d.folders.reduce((n, f) => n + f.items.length, 0) - 6 });
  });

  it('não altera o inventário recebido, e o selo continua válido', async () => {
    const d = await inventory(baseTree());
    const before = JSON.stringify(d);
    const p = plan(d, [moveFolder('/Raiz/Origem/2025', '/Raiz/Destino'), moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Outra')]);
    expect(JSON.stringify(d)).toBe(before);
    expect(p.proposals.length).toBeGreaterThan(0);
    expect(plan(d, []).validation.status).toBe('accepted');
  });
});

describe('12. determinismo', () => {
  const selections = [moveFolder('/Raiz/Origem/2025', '/Raiz/Destino'), moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Outra'), moveFolder('/Raiz/Origem/2024', '/Raiz/Nada'), moveFile('/Raiz/Outra', 'intocado.pdf', '/Raiz/Origem/2024')];

  it('mesma entrada, mesmo plano byte a byte; a ordem das seleções não muda nada', async () => {
    const d = await inventory(baseTree());
    const first = JSON.stringify(plan(d, selections));
    expect(JSON.stringify(plan(d, selections))).toBe(first);
    expect(JSON.stringify(plan(d, [...selections].reverse()))).toBe(first);
    expect(JSON.stringify(plan(JSON.parse(JSON.stringify(d)), [selections[2]!, selections[0]!, selections[3]!, selections[1]!]))).toBe(first);
  });

  it('o id não depende do momento nem da ordem das chaves da seleção, e muda com o inventário', async () => {
    const d = await inventory(baseTree());
    const ids = (p: MovementPlan) => p.proposals.map((x) => x.id);
    const later = planMovements(d, { selections }, { now: new Date('2026-11-04T12:00:00.000Z'), authenticator: AUTH });
    expect(ids(later)).toEqual(ids(plan(d, selections)));
    const reordered: MovementSelection = { destination: at('/Raiz/Outra'), name: 'solto.pdf', parent: at('/Raiz/Origem'), kind: 'file' };
    expect(ids(plan(d, [reordered]))).toEqual(ids(plan(d, [selections[1]!])));
    const resealed = JSON.parse(JSON.stringify(sealInventory(d, AUTH, new Date('2026-11-03T11:00:00.000Z')))) as TreeInventoryExport;
    expect(ids(plan(resealed, [selections[1]!]))).not.toEqual(ids(plan(d, [selections[1]!])));
  });
});

describe('13. proibição de exclusão, sobrescrita e execução', () => {
  const FORBIDDEN_KEY = /delet|exclu|remov|overwrit|sobrescr|replac|substitu|rename|renome|command|selector|^url$|apiCall/i;
  const walk = (value: unknown, visit: (key: string, v: unknown) => void): void => {
    if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) (visit(k, v), walk(v, visit));
  };
  const everything = async () =>
    plan(await inventory(baseTree()), [moveFolder('/Raiz/Origem/2025', '/Raiz/Destino'), moveFile('/Raiz/Origem', 'solto.pdf', '/Raiz/Nada'), contents('/Raiz/Origem/2024', '/Raiz/Outra'), moveFolder('/Raiz', '/Raiz/Outra')]);

  it('todo plano e toda proposta declaram não executável e não autorizante', async () => {
    const p = await everything();
    expect(p.proposals.length).toBeGreaterThan(3);
    expect(p).toMatchObject({ dryRun: true, executable: false, authorizesChanges: false, authenticated: false });
    walk(p, (key, value) => {
      if (key === 'executable' || key === 'authorizesChanges') expect(value).toBe(false);
    });
    for (const op of p.proposals) expect(op.review).toEqual({ status: 'pending', required: true, decidedBy: null, decidedAt: null });
  });

  it('só há três tipos de operação; nenhum campo de exclusão, sobrescrita, comando ou URL', async () => {
    const p = await everything();
    for (const op of p.proposals) expect(['move-file', 'move-folder', 'consolidate-folder']).toContain(op.kind);
    walk(p, (key) => expect(key).not.toMatch(FORBIDDEN_KEY));
  });

  it('avisos negam exclusão e sobrescrita', async () => {
    const p = await everything();
    expect(p.notices.join(' ')).toMatch(/Não há proposta de exclusão, substituição ou sobrescrita/);
    expect(p.notices.join(' ')).toMatch(/não é autenticado/);
  });

  it('o motor é puro: sem Playwright, sem sistema de arquivos, sem rede, sem adaptadores do AIR', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/core/movement-planner.ts'), 'utf-8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../types/inventory.js', './checkpoint.js', './duplicates.js', './organization-planner.js', './structural-diagnostics.js', 'node:crypto']);
    expect(source).not.toMatch(/\bfetch\(|playwright|\bpage\.|child_process|process\.env/i);
  });

  it('versão redigida não tem nomes, caminhos, seleções nem runId', async () => {
    const p = redactMovementPlan(await everything());
    expect(p.identifiable).toBe(false);
    const text = JSON.stringify(p);
    for (const sensitive of ['Origem', 'Destino', 'PROCESSO', 'solto.pdf', 'Janeiro', 'Sigiloso', 'sigiloso', 'run-sintetico', '"name"', '"path"', '"resultingPath"', '"requested"', '"observationKey"']) expect(text).not.toContain(sensitive);
    expect(p.proposals.length).toBeGreaterThan(3);
    expect(p.proposals[0]!.justification.length).toBeGreaterThan(0);
  });
});

describe('camada src/app', () => {
  it('prévia sobre arquivo gravado, sem criar chave nem gravar plano', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-movement-'));
    try {
      const keyFile = path.join(base, 'checkpoint.key');
      await writeFile(keyFile, KEY.toString('hex'));
      const outputDir = path.join(base, 'output');
      await mkdir(path.join(outputDir, 'env'), { recursive: true });
      const file_ = path.join(outputDir, 'env', 'tree-inventory.json');
      await writeFile(file_, JSON.stringify(await inventory(baseTree())));
      const { plan: result, keyUnavailable } = await planInventoryMovements(file_, { selections: [moveFolder('/Raiz/Origem/2025', '/Raiz/Destino')] }, { keyFile, maxAgeDays: 7, outputDir, now: NOW });
      expect(keyUnavailable).toBeUndefined();
      expect(result.validation.status).toBe('accepted');
      expect(result.summary.byKind['consolidate-folder']).toBe(2);
      expect(await readdir(path.join(outputDir, 'env'))).toEqual(['tree-inventory.json']);

      const noKey = await planInventoryMovements(file_, { selections: [] }, { keyFile: path.join(base, 'ausente.key'), maxAgeDays: 7, outputDir, now: NOW });
      expect(noKey.keyUnavailable).toBe('missing');
      expect(noKey.plan.validation.status).toBe('refused');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
