import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppController } from '../../src/app/controller.js';
import { blockingReasonLines, buildSelectionTree, parseInventoryId, parsePreviewRequest, selectionFrom } from '../../src/app/movement-review.js';
import { InvalidInput } from '../../src/app/validation.js';
import { sealInventory } from '../../src/core/inventory-integrity.js';
import type { MovementPlan } from '../../src/core/movement-planner.js';
import { scanTree } from '../../src/core/tree-scanner.js';
import { inventoryLabel, treeInventoryDocument } from '../../src/storage/export.js';
import { inventoryAuthenticator } from '../../src/storage/integrity-key.js';
import type { AirEnvironment, TreeInventoryExport, TreeLimits } from '../../src/types/inventory.js';
import { SimNavigator, file, folder, type SimNode } from '../sim-navigator.js';

/** Só dados SINTÉTICOS (nomes fictícios, domínio .test, chave fixa de teste, diretórios temporários). */
const WIDE: TreeLimits = { maxDepth: 10, maxFolders: 200, maxItems: 10_000, maxPagesPerFolder: 50 };
const KEY = Buffer.alloc(32, 7);
const AUTH = inventoryAuthenticator(KEY);
const finished = () => new Date(Date.now() - 60_000);
const env = (at: string): AirEnvironment => ({
  instanceOrigin: { status: 'identified', value: 'https://air.sigiloso.test', source: 'url' },
  pageUrl: { status: 'identified', value: 'https://air.sigiloso.test/air/my-air/raiz', source: 'url' },
  client: { status: 'identified', value: 'Cliente Sigiloso', source: 'operator' },
  sector: { status: 'identified', value: 'Setor Sigiloso', source: 'operator' },
  currentFolder: { status: 'identified', value: 'Raiz', source: 'page-heading' },
  breadcrumb: { status: 'not-identified', reason: 'x' },
  observedAt: at,
});

async function inventory(root: SimNode, opts: { homonyms?: 'identify-by-url'; limits?: TreeLimits; edit?: (d: TreeInventoryExport) => void } = {}): Promise<TreeInventoryExport> {
  const result = await scanTree(new SimNavigator(root), opts.limits ?? WIDE, opts.homonyms ? { homonyms: opts.homonyms } : {});
  const at = finished();
  const plain = JSON.parse(JSON.stringify(treeInventoryDocument(result, { runId: 'run-sintetico', startedAt: new Date(at.getTime() - 60_000).toISOString(), finishedAt: at.toISOString(), environment: env(at.toISOString()) }))) as TreeInventoryExport;
  opts.edit?.(plain);
  return JSON.parse(JSON.stringify(sealInventory(plain, AUTH, at))) as TreeInventoryExport;
}

const tree = () =>
  folder('raiz', 'Raiz', [
    folder('o', 'Origem Sigilosa', [file('f1', 'contrato-sigiloso.pdf'), folder('o25', '2025', [file('a', 'ata-sigilosa.pdf')]), folder('sub', 'Sub', [folder('neta', 'Neta')])]),
    folder('d', 'Destino Sigiloso', [folder('d25', '2025', [file('b', 'pauta-sigilosa.pdf')]), folder('v', 'Vazia Sigilosa')]),
  ]);
const SENSITIVE = ['Sigilos', 'sigilos', 'Raiz', 'Origem', 'Destino', 'Vazia', 'contrato', 'ata-', 'pauta', 'Neta', '.pdf', 'run-sintetico', 'air.', '"path"', '"name"', 'observationKey', 'pageUrl'];
const expectNoNames = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const term of SENSITIVE) expect(json).not.toContain(term);
};

const refOf = (d: TreeInventoryExport, p: string) => d.folders.find((f) => f.path === p)!.ref;

describe('árvore de seleção', () => {
  it('só identificadores opacos nos nós; nomes à parte; distingue arquivos de pastas', async () => {
    const t = buildSelectionTree(await inventory(tree()));
    expectNoNames(t.nodes);
    expect(t.nodes[0]).toMatchObject({ kind: 'folder', depth: 0, canBeSource: false, canBeDestination: true });
    const files = t.nodes.filter((n) => n.kind === 'file');
    expect(files.map((n) => n.id)).toEqual(['A1', 'A2', 'A3']);
    for (const n of files) expect(n).toMatchObject({ canBeSource: true, canBeDestination: false });
    expect(Object.values(t.names)).toContain('contrato-sigiloso.pdf');
    // Hierárquica: cada nó aparece depois do pai.
    t.nodes.forEach((n, i) => {
      if (n.parent) expect(t.nodes.findIndex((p) => p.id === n.parent)).toBeLessThan(i);
    });
  });

  it('pasta vazia com identidade derivada pode ser escolhida e é sinalizada', async () => {
    const d = await inventory(tree(), {
      edit: (x) => void delete x.folders.find((f) => f.path === '/Raiz/Destino Sigiloso/Vazia Sigilosa')!.path,
    });
    const ref = d.folders.find((f) => f.name === 'Vazia Sigilosa')!.ref;
    const t = buildSelectionTree(d);
    expect(t.nodes.find((n) => n.id === ref)).toMatchObject({ identity: 'derived', canBeDestination: true, canBeSource: true });
  });

  it('sem caminho comprovável: sinalizada, não selecionável', async () => {
    const d = await inventory(tree(), {
      edit: (x) => {
        const f = x.folders.find((y) => y.path === '/Raiz/Destino Sigiloso/Vazia Sigilosa')!;
        delete f.path;
        delete f.pageUrl;
      },
    });
    const ref = d.folders.find((f) => f.name === 'Vazia Sigilosa')!.ref;
    expect(buildSelectionTree(d).nodes.find((n) => n.id === ref)).toMatchObject({ identity: 'unavailable', canBeSource: false, canBeDestination: false });
  });

  it('homônimos e nomes repetidos: identidade ambígua, não selecionáveis', async () => {
    const t = folder('raiz', 'Raiz', [
      folder('h1', 'Dup', [file('a', 'a.pdf')]),
      folder('h2', 'Dup'),
      folder('o', 'O', [{ id: 'x', name: 'igual.pdf', type: 'file', createdAt: '01/01/2024' }, { id: 'y', name: 'igual.pdf', type: 'file', createdAt: '02/01/2024' }]),
    ]);
    const built = buildSelectionTree(await inventory(t, { homonyms: 'identify-by-url' }));
    const ambiguous = built.nodes.filter((n) => n.identity === 'ambiguous');
    expect(ambiguous.map((n) => n.kind).sort()).toEqual(['file', 'file', 'file', 'folder', 'folder']);
    for (const n of ambiguous) expect(n).toMatchObject({ canBeSource: false, canBeDestination: false });
  });
});

describe('seleção por identificadores', () => {
  const setup = async () => {
    const d = await inventory(tree());
    const t = buildSelectionTree(d);
    return { d, t, sub: refOf(d, '/Raiz/Origem Sigilosa/Sub'), neta: refOf(d, '/Raiz/Origem Sigilosa/Sub/Neta'), destino: refOf(d, '/Raiz/Destino Sigiloso'), root: refOf(d, '/Raiz') };
  };

  it('arquivo para pasta e pasta para pasta viram seleção com caminho exato e referência', async () => {
    const { t, sub, destino } = await setup();
    expect(selectionFrom(t, { source: 'A1', destination: destino })).toEqual({ kind: 'file', parent: { path: '/Raiz/Origem Sigilosa', ref: expect.any(String) }, name: 'contrato-sigiloso.pdf', destination: { path: '/Raiz/Destino Sigiloso', ref: destino } });
    expect(selectionFrom(t, { source: sub, destination: destino, mode: 'folder' })).toMatchObject({ kind: 'folder', source: { path: '/Raiz/Origem Sigilosa/Sub' } });
    expect(selectionFrom(t, { source: sub, destination: destino, mode: 'folder-contents' })).toMatchObject({ kind: 'folder-contents' });
  });

  it('recusa: mesma pasta, descendente, arquivo como destino, raiz, identificador desconhecido, sem o modo', async () => {
    const { t, sub, neta, destino, root } = await setup();
    const refused = (input: Parameters<typeof selectionFrom>[1], message: RegExp) => {
      expect(() => selectionFrom(t, input)).toThrow(InvalidInput);
      expect(() => selectionFrom(t, input)).toThrow(message);
    };
    refused({ source: sub, destination: sub, mode: 'folder' }, /mesma pasta/);
    refused({ source: sub, destination: neta, mode: 'folder' }, /descendente/);
    refused({ source: sub, destination: 'A1', mode: 'folder' }, /pasta de destino/);
    refused({ source: root, destination: destino, mode: 'folder' }, /origem/);
    refused({ source: 'F999', destination: destino }, /origem/);
    refused({ source: 'A1', destination: 'F999' }, /destino/);
    refused({ source: '/Raiz/Origem Sigilosa', destination: destino, mode: 'folder' }, /origem/); // caminho digitado não vale
    refused({ source: sub, destination: destino }, /o que fazer/);
    refused({ source: sub, destination: destino, mode: 'delete' }, /o que fazer/);
  });
});

describe('motivos de bloqueio do resumo', () => {
  const planWith = (issues: Array<{ conflicts?: string[]; blockers?: string[] }>, blocked = issues.length) =>
    ({ summary: { byState: { blocked } }, proposals: issues.map((i) => ({ conflicts: (i.conflicts ?? []).map((code) => ({ code })), blockers: (i.blockers ?? []).map((code) => ({ code })) })) }) as unknown as MovementPlan;

  it('agrupa os códigos do motor, sem nomes', () => {
    const lines = blockingReasonLines(planWith([{ conflicts: ['name-conflict', 'name-conflict'] }, { blockers: ['ambiguous-destination'] }, { blockers: ['dependency-cycle'] }, { blockers: ['destination-not-found'] }]));
    expect(lines).toEqual(['Conflitos: mesmo nome no destino: 2', 'Bloqueios de segurança: destino ambíguo: 1', 'Dependências não satisfeitas: ciclo de dependências: 1', 'Outros motivos: destino não encontrado: 1']);
  });

  it('nunca afirma que não há bloqueios: motivo ausente vira indicação neutra', () => {
    expect(blockingReasonLines(planWith([{}], 1))).toEqual(['Motivo não informado pelo motor: consulte cada proposta bloqueada.']);
    expect(blockingReasonLines(planWith([], 0))).toEqual([]);
  });

  it('código desconhecido não some: aparece como outro motivo', () => {
    expect(blockingReasonLines(planWith([{ blockers: ['codigo-futuro'] }]))).toEqual(['Outros motivos: codigo-futuro: 1']);
  });
});

describe('payload vindo da janela', () => {
  const id = `inv-${'a'.repeat(16)}`;

  it('aceita só o formato esperado', () => {
    expect(parsePreviewRequest({ inventoryId: id, source: 'A1', destination: 'F2' })).toEqual({ inventoryId: id, source: 'A1', destination: 'F2' });
    expect(parsePreviewRequest({ inventoryId: id, source: 'F3', destination: 'F2', mode: 'folder-contents' })).toMatchObject({ mode: 'folder-contents' });
  });

  it.each([
    ['nulo', null],
    ['lista', []],
    ['texto', 'A1'],
    ['campo desconhecido', { inventoryId: id, source: 'A1', destination: 'F2', path: 'C:/x' }],
    ['sem origem', { inventoryId: id, destination: 'F2' }],
    ['caminho como origem', { inventoryId: id, source: '/Raiz/Pasta', destination: 'F2' }],
    ['caminho como destino', { inventoryId: id, source: 'A1', destination: '../../fora' }],
    ['origem enorme', { inventoryId: id, source: `A${'1'.repeat(5000)}`, destination: 'F2' }],
    ['tipo errado', { inventoryId: id, source: 1, destination: 'F2' }],
    ['inventário como caminho', { inventoryId: 'C:/output/x/tree-inventory.json', source: 'A1', destination: 'F2' }],
    ['modo desconhecido', { inventoryId: id, source: 'F3', destination: 'F2', mode: 'delete' }],
  ])('recusa %s, sem repetir o valor na mensagem', (_label, payload) => {
    expect(() => parsePreviewRequest(payload)).toThrow(InvalidInput);
    try {
      parsePreviewRequest(payload);
    } catch (error) {
      expect((error as Error).message).not.toMatch(/Raiz|fora|C:\/|delete|1111/);
    }
  });

  it('identificador de inventário: só o formato opaco', () => {
    expect(parseInventoryId(id)).toBe(id);
    for (const bad of [undefined, 7, '', 'inv-x', '../tree-inventory.json', `${id}0`]) expect(() => parseInventoryId(bad)).toThrow(InvalidInput);
  });
});

describe('rótulo do inventário', () => {
  const at = (run: string) => path.resolve('output', 'inst', 'setor', run, 'tree-inventory.json');

  it('execução gerada pela ferramenta aparece; instância e setor nunca', () => {
    expect(inventoryLabel(at('2026-11-05t13-50-21-893z-255716a6-0e259060'))).toBe('output/*/*/2026-11-05t13-50-21-893z-255716a6-0e259060/tree-inventory.json');
    expect(inventoryLabel(at('2026-11-05T13-50-21-893Z-255716a6'))).toContain('2026-11-05T13-50-21-893Z');
  });

  it('pasta renomeada à mão fica mascarada até qualquer revelação', () => {
    for (const run of ['Fulano de Tal', '2026-11-05t13-50-21-893z-Fulano', 'relatorio']) {
      const label = inventoryLabel(at(run));
      expect(label).toBe('output/*/*/(execução omitida)/tree-inventory.json');
      expect(label).not.toContain(run);
    }
  });
});

describe('operações do controlador', () => {
  let base = '';
  let output = '';
  let controller: AppController;

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-review-'));
    output = path.join(base, 'output');
    await mkdir(path.join(base, 'air-organizer'), { recursive: true });
    await writeFile(path.join(base, 'air-organizer', 'checkpoint.key'), KEY.toString('hex'));
    controller = new AppController({ launch: () => Promise.reject(new Error('sem Chrome neste teste')), settingsFile: path.join(base, 'settings.json'), emit: () => {}, env: { LOCALAPPDATA: base }, outputDir: output });
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function save(doc: unknown, run: string): Promise<void> {
    const dir = path.join(output, 'instancia', 'setor', run);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'tree-inventory.json'), JSON.stringify(doc));
  }
  const inventoryId = async (index = 0) => (await controller.listInventories())[index]!.id;

  it('elegível: descreve o inventário e abre a seleção, sem nomes na resposta', async () => {
    const d = await inventory(tree());
    await save(d, 'run-a');
    const view = await controller.inspectInventory(await inventoryId());
    expect(view).toMatchObject({ eligible: true, completeness: 'COMPLETA', readMode: 'leitura direta, sem retomada', finishedAt: d.finishedAt, reasons: [], counts: { folders: d.folders.length, files: 3 } });
    expect(view.eligibility).toContain('ELEGÍVEL');
    expect(view.tree!.length).toBeGreaterThan(0);
    const { label: _label, ...rest } = view;
    expectNoNames(rest);
  });

  it('inelegível: pode ser consultado, sem árvore, e não gera propostas', async () => {
    await save(await inventory(tree(), { limits: { ...WIDE, maxDepth: 1 } }), 'run-a');
    const id = await inventoryId();
    const view = await controller.inspectInventory(id);
    expect(view).toMatchObject({ eligible: false, completeness: 'PARCIAL' });
    expect(view.tree).toBeUndefined();
    expect(view.counts).toBeDefined();
    expect(view.reasons.length).toBeGreaterThan(0);
    await expect(controller.previewProposals({ inventoryId: id, source: 'A1', destination: 'F1' })).rejects.toThrow(InvalidInput);
    expect(() => controller.revealSelectionNames(id)).toThrow(InvalidInput);
  });

  it('documento adulterado: recusado, sem contagens', async () => {
    await save({ ...(await inventory(tree())), runId: 'adulterado' }, 'run-a');
    const view = await controller.inspectInventory(await inventoryId());
    expect(view.eligible).toBe(false);
    expect(view.counts).toBeUndefined();
    expect(view.tree).toBeUndefined();
  });

  it('prévia: propostas não executáveis, sem nomes, e nada é gravado', async () => {
    const d = await inventory(tree());
    await save(d, 'run-a');
    const id = await inventoryId();
    await controller.inspectInventory(id);
    const before = await readdir(path.join(output, 'instancia', 'setor', 'run-a'));
    const content = await readFile(path.join(output, 'instancia', 'setor', 'run-a', 'tree-inventory.json'), 'utf-8');

    const view = await controller.previewProposals({ inventoryId: id, source: refOf(d, '/Raiz/Origem Sigilosa/2025'), destination: refOf(d, '/Raiz/Destino Sigiloso'), mode: 'folder' });
    expect(view).toMatchObject({ accepted: true, executable: false, authorizesChanges: false });
    expect(view.proposals.map((p) => [p.kind, p.state])).toEqual([['consolidate-folder', 'ready-for-review'], ['move-file', 'ready-for-review']]);
    expect(view.proposals[0]).toMatchObject({ source: refOf(d, '/Raiz/Origem Sigilosa/2025'), destination: refOf(d, '/Raiz/Destino Sigiloso/2025'), group: { status: 'all-ready', authorizesOperations: false } });
    expect(view.proposals[1]!.source).toMatch(/^A\d+$/);
    for (const p of view.proposals) expect(p).toMatchObject({ executable: false, authorizesChanges: false, review: 'pending' });
    const { notices: _n, ...rest } = view;
    expectNoNames(rest);

    expect(await readdir(path.join(output, 'instancia', 'setor', 'run-a'))).toEqual(before);
    expect(await readFile(path.join(output, 'instancia', 'setor', 'run-a', 'tree-inventory.json'), 'utf-8')).toBe(content);
  });

  it('arquivo para pasta vazia com caminho derivado: apta e sinalizada', async () => {
    const d = await inventory(tree(), { edit: (x) => void delete x.folders.find((f) => f.path === '/Raiz/Destino Sigiloso/Vazia Sigilosa')!.path });
    await save(d, 'run-a');
    const id = await inventoryId();
    await controller.inspectInventory(id);
    const empty = d.folders.find((f) => f.name === 'Vazia Sigilosa')!.ref;
    const view = await controller.previewProposals({ inventoryId: id, source: 'A1', destination: empty });
    expect(view.proposals[0]).toMatchObject({ kind: 'move-file', state: 'ready-for-review', destination: empty, derivedPath: true });
    expectNoNames(view.proposals);
  });

  it('consolidações parcial e totalmente bloqueadas chegam à tela, sem liberar nada', async () => {
    const consolidation = (conflicting: SimNode[]) => folder('raiz', 'Raiz', [folder('o', 'O', [folder('o1', '2025', [file('a', 'ata.pdf'), file('b', 'lista.pdf')])]), folder('d', 'D', [folder('d1', '2025', conflicting)])]);
    const run = async (conflicting: SimNode[]) => {
      const d = await inventory(consolidation(conflicting));
      await save(d, 'run-a');
      const id = await inventoryId();
      await controller.inspectInventory(id);
      return controller.previewProposals({ inventoryId: id, source: refOf(d, '/Raiz/O/2025'), destination: refOf(d, '/Raiz/D'), mode: 'folder' });
    };

    const partial = await run([file('e', 'ata.pdf')]);
    expect(partial.proposals[0]).toMatchObject({ kind: 'consolidate-folder', state: 'ready-for-review', executable: false, group: { status: 'partially-blocked', authorizesOperations: false } });
    expect(partial.summary.consolidations['partially-blocked']).toBe(1);
    expect(partial.categories).toEqual({ conflicts: { 'name-conflict': 1 }, blockers: {} });
    const blocked = partial.proposals.find((p) => p.state === 'blocked')!;
    expect(blocked).toMatchObject({ executable: false, authorizesChanges: false });
    expect(partial.safeOrder).not.toContain(blocked.id);

    const full = await run([file('e', 'ata.pdf'), file('f', 'LISTA.pdf')]);
    expect(full.proposals[0]).toMatchObject({ state: 'blocked', group: { status: 'fully-blocked', authorizesOperations: false, readyOperations: [] } });
    expect(full.safeOrder).toEqual([]);
    expect(full.categories.conflicts).toEqual({ 'equivalent-name-conflict': 1, 'name-conflict': 1 });
    expect(full.blockingReasons).toEqual(['Conflitos: nome equivalente no destino: 1 · mesmo nome no destino: 1', 'Dependências não satisfeitas: depende de operação bloqueada: 2 · nenhuma operação apta na consolidação: 1']);
    expect(partial.blockingReasons).toEqual(['Conflitos: mesmo nome no destino: 1']);
    // As filhas já bloqueadas passam a depender também do agrupamento bloqueado.
    expect(full.categories.blockers).toEqual({ 'dependency-blocked': 2, 'no-ready-operations': 1 });
  });

  it('erros sanitizados: JSON corrompido e chave ausente não expõem nomes, caminhos nem conteúdo', async () => {
    const dir = path.join(output, 'instancia', 'setor-sigiloso', 'run-a');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'tree-inventory.json'), '{"name": "Fulano Sigiloso 111.222.333-44", quebrado');
    const id = await inventoryId();
    const failure = await controller.inspectInventory(id).catch((error: unknown) => controller.describeError(error));
    const text = JSON.stringify(failure);
    expect(text).toContain('local-failure');
    for (const term of ['Fulano', '111.222', 'setor-sigiloso', base.replace(/\\/g, '/'), 'quebrado']) expect(text).not.toContain(term);

    await rm(path.join(base, 'air-organizer', 'checkpoint.key'));
    await writeFile(path.join(dir, 'tree-inventory.json'), JSON.stringify(await inventory(tree())));
    const view = await controller.inspectInventory(id);
    expect(view).toMatchObject({ eligible: false });
    expect(view.tree).toBeUndefined();
    const { label: _label, ...rest } = view;
    expectNoNames(rest);
  });

  it('conflito do motor chega à tela como bloqueio, sem nomes', async () => {
    const t = folder('raiz', 'Raiz', [folder('o', 'Origem Sigilosa', [file('a', 'ata-sigilosa.pdf')]), folder('d', 'Destino Sigiloso', [file('b', 'ata-sigilosa.pdf')])]);
    const d = await inventory(t);
    await save(d, 'run-a');
    const id = await inventoryId();
    const { tree: nodes } = await controller.inspectInventory(id);
    const view = await controller.previewProposals({ inventoryId: id, source: nodes!.find((n) => n.kind === 'file')!.id, destination: refOf(d, '/Raiz/Destino Sigiloso') });
    expect(view.proposals[0]).toMatchObject({ state: 'blocked', conflicts: [{ code: 'name-conflict' }] });
    expect(view.safeOrder).toEqual([]);
    expectNoNames(view.proposals);
  });

  it('nomes só por pedido explícito, do inventário aberto; não misturam inventários', async () => {
    await save(await inventory(tree()), 'run-a');
    await save(await inventory(folder('raiz', 'Outra Raiz', [folder('x', 'X', [file('z', 'z.pdf')]), folder('y', 'Y')])), 'run-b');
    const [a, b] = [await inventoryId(0), await inventoryId(1)];
    expect(() => controller.revealSelectionNames(a)).toThrow(InvalidInput);

    await controller.inspectInventory(a);
    const namesA = Object.values(controller.revealSelectionNames(a));
    await expect(controller.previewProposals({ inventoryId: b, source: 'A1', destination: 'F1' })).rejects.toThrow(InvalidInput);
    expect(() => controller.revealSelectionNames(b)).toThrow(InvalidInput);

    // Abrir outro inventário descarta os identificadores do anterior.
    await controller.inspectInventory(b);
    const namesB = Object.values(controller.revealSelectionNames(b));
    expect([...namesA, ...namesB]).toEqual(expect.arrayContaining(['contrato-sigiloso.pdf', 'z.pdf']));
    expect(namesA.filter((n) => namesB.includes(n))).toEqual([]);
    expect(() => controller.revealSelectionNames(a)).toThrow(InvalidInput);
    await expect(controller.previewProposals({ inventoryId: a, source: 'A1', destination: 'F1' })).rejects.toThrow(InvalidInput);
  });

  it('inventário trocado depois da análise: recusa e exige nova análise', async () => {
    const d = await inventory(tree());
    await save(d, 'run-a');
    const id = await inventoryId();
    await controller.inspectInventory(id);
    await save(await inventory(tree()), 'run-a'); // novo selo, mesmo arquivo
    await expect(controller.previewProposals({ inventoryId: id, source: 'A1', destination: refOf(d, '/Raiz/Destino Sigiloso') })).rejects.toThrow(/mudou desde a análise/);
    expect(() => controller.revealSelectionNames(id)).toThrow(InvalidInput);
  });

  it('entrada inválida da janela é recusada, com mensagem sem nomes', async () => {
    await save(await inventory(tree()), 'run-a');
    const id = await inventoryId();
    await expect(controller.inspectInventory('/caminho/digitado')).rejects.toThrow(InvalidInput);
    await controller.inspectInventory(id);
    await expect(controller.previewProposals(null)).rejects.toThrow(InvalidInput);
    await expect(controller.previewProposals({ inventoryId: id, source: 'Origem Sigilosa', destination: 'F1' })).rejects.toThrow(/Escolha uma origem/);
  });
});
