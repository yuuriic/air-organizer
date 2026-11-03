import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CheckpointFolder } from '../../src/core/checkpoint.js';
import { analyzeStructure, formatFinding, redactReport, validateInventory, type StructuralReport } from '../../src/core/structural-diagnostics.js';
import { scanTree } from '../../src/core/tree-scanner.js';
import { treeInventoryDocument } from '../../src/storage/export.js';
import type { AirEnvironment, ResumeMode, TreeInventoryExport, TreeLimits } from '../../src/types/inventory.js';
import { SimNavigator, file, files, folder, type SimBehavior, type SimNode } from '../sim-navigator.js';

/**
 * Inventários inteiramente SINTÉTICOS, gerados pela leitura recursiva real sobre o simulador e
 * exportados com a mesma função do tree-inventory.json — o formato é o de produção.
 */
const WIDE: TreeLimits = { maxDepth: 10, maxFolders: 200, maxItems: 10_000, maxPagesPerFolder: 50 };
const FINISHED = '2026-11-03T10:05:00.000Z';
const NOW = new Date('2026-11-03T12:00:00.000Z');
const ENV: AirEnvironment = {
  instanceOrigin: { status: 'identified', value: 'https://air.exemplo.test', source: 'url' },
  pageUrl: { status: 'identified', value: 'https://air.exemplo.test/air/my-air/raiz', source: 'url' },
  client: { status: 'not-identified', reason: 'x' },
  sector: { status: 'identified', value: 'Setor Ficticio', source: 'operator' },
  currentFolder: { status: 'identified', value: 'Raiz', source: 'page-heading' },
  breadcrumb: { status: 'not-identified', reason: 'x' },
  observedAt: FINISHED,
};
const pseudonymize = (v: string) => createHmac('sha256', 'k').update(v).digest('hex').slice(0, 32);

async function inventory(
  root: SimNode,
  opts: { behavior?: SimBehavior; limits?: TreeLimits; resume?: { from: CheckpointFolder[]; mode: ResumeMode } } = {},
): Promise<{ doc: TreeInventoryExport; checkpoint: CheckpointFolder[] }> {
  let checkpoint: CheckpointFolder[] = [];
  const result = await scanTree(new SimNavigator(root, opts.behavior), opts.limits ?? WIDE, {
    checkpoint: { pseudonymize, save: async (s) => void (checkpoint = s.folders), resume: opts.resume },
  });
  const doc = treeInventoryDocument(result, { runId: 'run-sintetico', startedAt: '2026-11-03T10:00:00.000Z', finishedAt: FINISHED, environment: ENV });
  return { doc: JSON.parse(JSON.stringify(doc)) as TreeInventoryExport, checkpoint }; // como lido do disco
}

const analyze = (doc: unknown, now = NOW) => analyzeStructure(doc, { now });
const rules = (r: StructuralReport) => r.findings.map((f) => f.rule);

describe('A. possíveis duplicidades (pastas irmãs)', () => {
  it('nomes idênticos e conteúdos diferentes: achado exato, sem afirmar conteúdo igual nem sugerir mescla', async () => {
    const root = folder('raiz', 'Raiz', [folder('c1', 'Contratos', files('a', 3)), folder('c2', 'Contratos', [folder('x', 'Outro'), file('b')])]);
    const r = analyze((await inventory(root)).doc);
    const [f] = r.findings.filter((x) => x.category === 'possible-duplicate');
    expect(f).toMatchObject({ rule: 'DUP-SIBLING-EXACT', certainty: 'exact', requiresHumanReview: true, measures: { pastas: 2, naoAbertas: 2 } });
    expect(f!.folders.map((e) => e.ref)).toEqual(['F1', 'F2', 'F3']); // pai + duas irmãs
    expect(f!.folders.slice(1).every((e) => e.status === 'skipped' && e.counts === undefined)).toBe(true); // homônimos não são abertos
    expect(f!.limitations.join(' ')).toMatch(/não indica conteúdo igual/i);
    expect(f!.limitations.join(' ')).toMatch(/não indica que as pastas possam ser mescladas/i);
    expect(JSON.stringify(f)).not.toMatch(/renome|mover|mescl[ae]r? as pastas|recomend/i);
  });

  it('irmãs equivalentes por caixa, acento e pontuação: achado normalizado com as regras aplicadas', async () => {
    const root = folder('raiz', 'Raiz', [folder('a', 'PLANETAS'), folder('b', 'Planetas'), folder('c', 'Órbitas'), folder('d', 'orbitas'), folder('e', 'Mapas-Estelares'), folder('f', 'Mapas Estelares')]);
    const r = analyze((await inventory(root)).doc);
    expect(r.findings.map((f) => [f.rule, f.matchedBy, f.names?.variants])).toEqual([
      ['DUP-SIBLING-NORMALIZED', ['case'], ['PLANETAS', 'Planetas']],
      ['DUP-SIBLING-NORMALIZED', ['case', 'diacritics'], ['orbitas', 'Órbitas']],
      ['DUP-SIBLING-NORMALIZED', ['punctuation'], ['Mapas Estelares', 'Mapas-Estelares']],
    ]);
  });
});

describe('B. nomenclatura inconsistente (pais diferentes)', () => {
  it('variações de caixa, acento e espaços do mesmo nome em pais diferentes', async () => {
    const root = folder('raiz', 'Raiz', [
      folder('a', 'Alfa', [folder('a1', 'Orbitas')]),
      folder('b', 'Beta', [folder('b1', 'ÓRBITAS')]),
      folder('c', 'Gama', [folder('c1', 'Mapas  Estelares')]),
      folder('d', 'Delta', [folder('d1', 'Mapas Estelares')]),
    ]);
    const r = analyze((await inventory(root)).doc);
    const variants = r.findings.filter((f) => f.rule === 'NAME-VARIANTS');
    expect(variants.map((f) => [f.matchedBy, f.measures])).toEqual([
      [['case', 'diacritics'], { grafias: 2, ocorrencias: 2, pais: 2 }],
      [['whitespace'], { grafias: 2, ocorrencias: 2, pais: 2 }],
    ]);
    expect(r.findings.filter((f) => f.rule === 'NAME-SPACING').map((f) => f.folders[0]!.name)).toEqual(['Mapas  Estelares']);
    expect(r.findings.every((f) => f.requiresHumanReview)).toBe(true);
    expect(JSON.stringify(r.findings)).not.toMatch(/adotar a grafia|renomear para/i);
  });

  it('mesma grafia em vários pais (ex.: anos) não é inconsistência', async () => {
    const year = (id: string) => folder(id, '2025', files(id, 1));
    const root = folder('raiz', 'Raiz', [folder('a', 'Alfa', [year('a1')]), folder('b', 'Beta', [year('b1')]), folder('c', 'Gama', [year('c1')])]);
    expect(analyze((await inventory(root)).doc).findings).toEqual([]);
  });
});

describe('C. hierarquia divergente', () => {
  it('pastas equivalentes com quase as mesmas subpastas: diferença estrutural registrada com as medidas', async () => {
    const anos = (p: string, ys: string[]) => ys.map((y) => folder(`${p}${y}`, y));
    const root = folder('raiz', 'Raiz', [
      folder('a', 'Alfa', [folder('ag', 'Arquivo Geral', anos('a', ['2021', '2022', '2023']))]),
      folder('b', 'Beta', [folder('bg', 'Arquivo Geral', anos('b', ['2021', '2023']))]),
    ]);
    const r = analyze((await inventory(root)).doc);
    const [f] = r.findings.filter((x) => x.rule === 'HIER-EQUIVALENT-CHILDREN');
    expect(f).toMatchObject({ category: 'divergent-hierarchy', certainty: 'structural', measures: { emComum: 2, soNaPrimeira: 1, soNaSegunda: 0, uniao: 3 } });
    expect(f!.names?.common).toEqual(['2021', '2023']);
    expect(Object.values(f!.names!.onlyIn!)).toEqual([['2022'], []]);
    expect(f!.limitations.join(' ')).toMatch(/legitimamente diferentes/);
  });

  it('estruturas divergentes legítimas (pouco em comum) e iguais não geram achado', async () => {
    const root = folder('raiz', 'Raiz', [
      folder('a', 'Alfa', [folder('ap', 'Projetos', [folder('a1', 'Planejamento'), folder('a2', 'Execucao')])]),
      folder('b', 'Beta', [folder('bp', 'Projetos', [folder('b1', 'Compras'), folder('b2', 'Frota')])]),
      folder('c', 'Gama', [folder('cr', 'Registros', [folder('c1', 'Norte'), folder('c2', 'Sul')])]),
      folder('d', 'Delta', [folder('dr', 'Registros', [folder('d1', 'Norte'), folder('d2', 'Sul')])]),
    ]);
    expect(rules(analyze((await inventory(root)).doc))).toEqual([]);
  });

  it('subpasta com o mesmo nome da pasta que a contém', async () => {
    const root = folder('raiz', 'Raiz', [folder('c', 'Catalogo', [folder('cc', 'Catalogo', files('x', 1))])]);
    expect(analyze((await inventory(root)).doc).findings.map((f) => [f.rule, f.certainty])).toEqual([['HIER-NESTED-SAME-NAME', 'exact']]);
  });
});

describe('elegibilidade (reutiliza a verificação da leitura)', () => {
  const tree = () => folder('raiz', 'Raiz', [folder('a', 'Alfa', [folder('a1', 'Planetas')]), folder('b', 'Beta', [folder('b1', 'PLANETAS')]), folder('c', 'Gama')]);

  it('leitura completa, revalidada e recente: elegível para planejamento', async () => {
    const r = analyze((await inventory(tree())).doc);
    expect(r.eligibility).toEqual({ status: 'planning-eligible', reasons: [] });
    expect(r.findings).toHaveLength(1);
  });

  it('inventário incompleto (limite): só exploratório, mesmo com achados', async () => {
    const r = analyze((await inventory(tree(), { limits: { ...WIDE, maxFolders: 2 } })).doc);
    expect(r.eligibility).toEqual({ status: 'exploratory', reasons: ['status-partial', 'not-eligible-for-planning'] });
  });

  it('retomada RÁPIDA: exploratório; pastas reaproveitadas sem nome ficam fora das regras', async () => {
    const first = await inventory(tree(), { behavior: { lose: ['c'] } });
    const fast = await inventory(tree(), { resume: { from: first.checkpoint, mode: 'fast' } });
    expect(fast.doc.status).toBe('complete');
    const r = analyze(fast.doc);
    expect(r.eligibility).toMatchObject({ status: 'exploratory', reasons: expect.arrayContaining(['fast-resume', 'reused-folders', 'not-eligible-for-planning']) });
    expect(r.coverage.foldersWithName).toBeLessThan(r.coverage.folders);
    expect(r.coverage.foldersRead).toBeLessThan(r.coverage.folders);
  });

  it('conteúdo divergente durante a leitura (ADR-013): exploratório', async () => {
    const r = analyze((await inventory(tree(), { behavior: { changeOnBack: { a: { total: true, listing: true } } } })).doc);
    expect(r.eligibility.reasons).toEqual(expect.arrayContaining(['content-changed', 'status-partial']));
  });

  it('inventário desatualizado e formato anterior à POC-01E: exploratório', async () => {
    const { doc } = await inventory(tree());
    expect(analyze(doc, new Date('2026-11-20T00:00:00.000Z')).eligibility).toEqual({ status: 'exploratory', reasons: ['stale'] });
    const legacy = { ...doc } as Partial<TreeInventoryExport>;
    delete legacy.verification;
    delete legacy.navigation;
    expect(analyze(legacy).eligibility.reasons).toContain('legacy-format');
  });
});

describe('falha segura diante de inconsistências', () => {
  it.each<[string, (d: TreeInventoryExport) => unknown]>([
    ['relatório sem nomes (tree-diagnostic.json)', (d) => ({ ...d, identifiable: false })],
    ['referência repetida', (d) => ({ ...d, folders: [...d.folders, d.folders[1]] })],
    ['pai inexistente', (d) => ({ ...d, folders: d.folders.map((f, i) => (i === 2 ? { ...f, parentRef: 'F99' } : f)) })],
    ['contagem divergente da listagem', (d) => ({ ...d, folders: d.folders.map((f, i) => (i === 0 ? { ...f, counts: { ...f.counts, folders: 9 } } : f)) })],
    ['subpasta com nome diferente da linha do pai', (d) => ({ ...d, folders: d.folders.map((f, i) => (i === 1 ? { ...f, name: 'Outro' } : f)) })],
    ['profundidade incoerente', (d) => ({ ...d, folders: d.folders.map((f, i) => (i === 1 ? { ...f, depth: 5 } : f)) })],
    ['entrada de pasta inválida', (d) => ({ ...d, folders: [...d.folders.slice(0, 1), null, ...d.folders.slice(2)] })],
    ['item de pasta inválido', (d) => ({ ...d, folders: d.folders.map((f, i) => (i === 0 ? { ...f, items: [{ ...f.items[0], kind: 'unexpected' }] } : f)) })],
    [
      'status geral incompatível com as pastas',
      (d) => ({
        ...d,
        status: 'complete',
        verification: { ...d.verification, eligibleForPlanning: true },
        folders: d.folders.map((f, i) => (i === 1 ? { ...f, status: 'partial', subtreeStatus: 'partial' } : f)),
      }),
    ],
    ['documento de outro tipo', () => ({ kind: 'outro' })],
  ])('%s: recusado, sem achados', async (_, tamper) => {
    const { doc } = await inventory(folder('raiz', 'Raiz', [folder('a', 'PLANETAS'), folder('b', 'Planetas')]));
    const r = analyze(tamper(doc));
    expect(r.eligibility.status).toBe('rejected');
    expect(r.findings).toEqual([]);
    expect(validateInventory(tamper(doc)).length).toBeGreaterThan(0);
  });
});

describe('privacidade de inventários malformados (referências e datas adulteradas)', () => {
  // Valores SINTÉTICOS que imitam dados sensíveis num campo que deveria conter F<n> ou uma data.
  const SENSITIVE = ['Fulano de Tal 111.222.333-44', 'https://air.sigiloso.test/pasta?token=TOKSECRETO999', 'Bearer TOKSECRETO999', 'BELTRANA DE TAL'];
  const LEAKS = ['Fulano', '111.222', 'sigiloso', 'TOKSECRETO', 'Bearer', 'BELTRANA', 'https://'];
  const at = (d: TreeInventoryExport, i: number, patch: Record<string, unknown>) => ({ ...d, folders: d.folders.map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  const cases = SENSITIVE.flatMap((value) => [
    [`ref da pasta inicial = ${value}`, (d: TreeInventoryExport) => at(d, 0, { ref: value })],
    [`ref de subpasta = ${value}`, (d: TreeInventoryExport) => at(d, 1, { ref: value })],
    [`parentRef = ${value}`, (d: TreeInventoryExport) => at(d, 1, { parentRef: value })],
    [`ref e parentRef = ${value}`, (d: TreeInventoryExport) => at(d, 2, { ref: value, parentRef: value, name: 'Outro' })],
    [`ref repetida = ${value}`, (d: TreeInventoryExport) => ({ ...at(d, 1, { ref: value }), folders: [...at(d, 1, { ref: value }).folders, { ...d.folders[2]!, ref: value }] })],
    [`finishedAt = ${value} 2026`, (d: TreeInventoryExport) => ({ ...d, finishedAt: `${value} 2026` })],
  ] as const);

  it.each(cases)('%s: recusado, sem reproduzir o valor nos motivos nem no relatório sem nomes', async (_, tamper) => {
    const { doc } = await inventory(folder('raiz', 'Raiz', [folder('a', 'PLANETAS'), folder('b', 'Planetas')]));
    const r = analyze(tamper(doc));
    expect(r.eligibility.status).toBe('rejected');
    expect(r.findings).toEqual([]);
    const exposed = [r.eligibility.reasons.join('; '), JSON.stringify(redactReport(r)), JSON.stringify(r)].join('\n');
    for (const s of LEAKS) expect(exposed).not.toContain(s);
  });

  it('referências válidas continuam citadas nos motivos', async () => {
    const { doc } = await inventory(folder('raiz', 'Raiz', [folder('a', 'PLANETAS'), folder('b', 'Planetas')]));
    expect(validateInventory(at(doc, 2, { parentRef: 'F99' }))).toContain('F3: pai F99 inexistente');
    expect(validateInventory(at(doc, 1, { parentRef: 'Fulano de Tal' }))).toContain('F2: referência do pai inválida');
    expect(validateInventory(at(doc, 1, { ref: 'Fulano de Tal', name: 'Outro' }))).toEqual(expect.arrayContaining(['referência de pasta inválida', 'pasta com referência inválida: nome diverge da linha correspondente no pai']));
  });

  it('identificadores da execução com texto sensível não chegam ao relatório sem nomes', async () => {
    const { doc } = await inventory(folder('raiz', 'Raiz', [folder('a', 'PLANETAS'), folder('b', 'Planetas')]));
    const r = analyze({ ...doc, runId: SENSITIVE[0], checkpointRunId: SENSITIVE[1] });
    expect(r.eligibility.status).not.toBe('rejected');
    const exposed = JSON.stringify(redactReport(r)) + r.findings.map(formatFinding).join('\n');
    for (const s of LEAKS) expect(exposed).not.toContain(s);
  });
});

describe('ausência de diagnósticos indevidos e determinismo', () => {
  it('árvore com nomes distintos e sufixos legítimos: nenhum achado', async () => {
    const root = folder('raiz', 'Raiz', [
      folder('a', 'Catalogo', [folder('a1', 'Catalogo-2031'), file('relatorio.pdf'), file('relatorio.pdf-copia')]),
      folder('b', 'Planeta 1'),
      folder('c', 'Planeta 11'),
    ]);
    expect(analyze((await inventory(root)).doc).findings).toEqual([]);
  });

  it('mesmo inventário e mesma data: relatório idêntico, independente da ordem das pastas no arquivo', async () => {
    const root = folder('raiz', 'Raiz', [folder('a', 'Alfa', [folder('a1', 'Orbitas')]), folder('b', 'Beta', [folder('b1', 'ÓRBITAS')]), folder('x', 'PLANETAS'), folder('y', 'Planetas')]);
    const { doc } = await inventory(root);
    const once = JSON.stringify(analyze(doc));
    expect(JSON.stringify(analyze(doc))).toBe(once);
    expect(JSON.stringify(analyze({ ...doc, folders: [...doc.folders].reverse() }))).toBe(once);
  });

  it('relatório redigido e linhas de console não contêm nomes, caminhos nem URLs', async () => {
    const root = folder('raiz', 'BELTRANA DE TAL', [folder('a', 'REGISTRO 111.222.333-44'), folder('b', 'registro 111.222.333-44'), folder('c', 'CICRANO', [folder('c1', 'Cicrano')])]);
    const r = analyze((await inventory(root)).doc);
    expect(r.findings.length).toBeGreaterThan(0);
    const exposed = JSON.stringify(redactReport(r)) + r.findings.map(formatFinding).join('\n');
    for (const s of ['BELTRANA', '111.222', 'CICRANO', 'Cicrano', 'air.exemplo.test', 'my-air', 'run-sintetico', '/BELTRANA', '"name":', '"path":', '"names":']) expect(exposed).not.toContain(s);
    expect(redactReport(r).identifiable).toBe(false);
  });
});
