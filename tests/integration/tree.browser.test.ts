import { createHmac } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAirTreeNavigator } from '../../src/air/tree-navigator.js';
import type { CheckpointFolder } from '../../src/core/checkpoint.js';
import { diagnosticReport, formatTreeEvent, scanTree, type TreeCheckpointSnapshot } from '../../src/core/tree-scanner.js';
import type { TreeEvent, TreeLimits } from '../../src/types/inventory.js';
import { airTreeHtml, type TreeFixtureOptions, type TreeNode } from '../fixtures/air-tree.js';

/** Leitura recursiva com o adaptador real sobre a fixture (Chrome headless, origem falsa, nada sai da máquina). */
const ORIGIN = 'https://air.fixture.test';
const NAV = { timeoutMs: 5_000, pollMs: 40, readTimeoutMs: 5_000 };
const WIDE: TreeLimits = { maxDepth: 5, maxFolders: 50, maxItems: 1_000, maxPagesPerFolder: 20 };

let browser: Browser | undefined;
let launchError: unknown;
beforeAll(async () => {
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (error) {
    launchError = error;
  }
});
afterAll(async () => {
  await browser?.close();
});

const files = (prefix: string, n: number): TreeNode[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-f${i}`, name: `${prefix} ${String(i + 1).padStart(2, '0')}.pdf`, type: 'file' }));
const dir = (id: string, name: string, children: TreeNode[] = []): TreeNode => ({ id, name, type: 'folder', children });

/** Com páginas de 2 itens: "Setor" tem 5 filhos (3 páginas); "C" está na página 2 e "E" na 3. */
const TREE = dir('root', 'Setor', [
  dir('a', 'A', [dir('a1', 'A1', files('a1', 3)), ...files('a', 2)]),
  dir('b', 'B'),
  dir('c', 'C', files('c', 1)),
  ...files('s', 1),
  dir('e', 'E', [dir('e1', 'E1')]),
]);

async function open(root: TreeNode, start: string, options: Partial<TreeFixtureOptions> = {}): Promise<Page> {
  if (!browser) throw new Error(`Chrome indisponível para testes: ${String(launchError)}`);
  const context = await browser.newContext();
  const html = airTreeHtml({ root, pageSize: 2, ...options });
  await context.route('**/*', (route) =>
    route.request().url().startsWith(`${ORIGIN}/`) ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort(),
  );
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/air/my-air/${start}`);
  return page;
}

const read = <T>(page: Page, key: string) => page.evaluate((k) => (window as unknown as Record<string, T>)[k], key);

describe('leitura recursiva com o adaptador do AIR (fixture)', () => {
  it('percorre a árvore paginada inteira, reposicionando o pai, sem cliques proibidos', async () => {
    const page = await open(TREE, 'root', { renderDelayMs: 60 });
    const events: TreeEvent[] = [];
    const r = await scanTree(createAirTreeNavigator(page, {}, NAV), WIDE, { onEvent: (e) => events.push(e) });

    expect(r.status).toBe('complete');
    expect(r.folders.map((f) => [f.name, f.depth, f.status, f.counts.items, f.counts.pagesRead])).toEqual([
      ['Setor', 0, 'complete', 5, 3],
      ['A', 1, 'complete', 3, 2],
      ['B', 1, 'complete', 0, 1],
      ['C', 1, 'complete', 1, 1],
      ['E', 1, 'complete', 1, 1],
      ['A1', 2, 'complete', 3, 2],
      ['E1', 2, 'complete', 0, 1],
    ]);
    expect(r.totals).toMatchObject({ foldersRead: 7, items: 13, files: 7, unknown: 0 });
    // __visits registra aberturas e voltas pelo breadcrumb; voltas do 3º nível usam o "voltar" (histórico).
    expect(await read<string[]>(page, '__visits')).toEqual(['a', 'a1', 'root', 'b', 'root', 'c', 'root', 'e', 'e1', 'root']);
    expect(((await read<string[]>(page, '__navClicks')) ?? []).filter((c) => c === 'back')).toHaveLength(2);
    expect(await read<string[]>(page, '__forbiddenClicks')).toEqual([]);
    // Volta à página da subpasta pelo número da página antes de abri-la.
    expect(await read<string[]>(page, '__navClicks')).toEqual(expect.arrayContaining(['page:1', 'page:2', 'page:3']));
    expect(page.url()).toBe(`${ORIGIN}/air/my-air/root`);
    expect(events.filter((e) => e.type === 'folder-read')).toHaveLength(7);
    await page.context().close();
  });

  it('respeita maxDepth e maxFolders e registra cobertura parcial', async () => {
    const page = await open(TREE, 'root');
    const r = await scanTree(createAirTreeNavigator(page, {}, NAV), { ...WIDE, maxDepth: 1, maxFolders: 3 });
    expect(r.status).toBe('partial');
    expect(r.folders.filter((f) => f.status !== 'skipped').map((f) => f.name)).toEqual(['Setor', 'A', 'B']);
    expect(r.folders.filter((f) => f.status === 'skipped').map((f) => [f.name, f.reasons])).toEqual([
      ['C', ['max-folders']],
      ['E', ['max-folders']],
      ['A1', ['max-depth']],
    ]);
    expect(await read<string[]>(page, '__visits')).toEqual(['a', 'root', 'b', 'root']);
    await page.context().close();
  });

  it('homônimos e itens de tipo desconhecido não são abertos', async () => {
    const root = dir('root', 'Setor', [dir('x1', 'Docs', files('x1', 1)), dir('x2', 'Docs'), ...files('u', 1), dir('ok', 'Ok')]);
    const page = await open(root, 'root', { pageSize: 30, fileAlt: null });
    const r = await scanTree(createAirTreeNavigator(page, {}, NAV), WIDE);
    expect(await read<string[]>(page, '__visits')).toEqual(['ok', 'root']);
    expect(r.folders.filter((f) => f.name === 'Docs').map((f) => f.reasons)).toEqual([['homonym'], ['homonym']]);
    expect(r.folders[0]).toMatchObject({ status: 'complete', subtreeStatus: 'partial', reasons: ['unknown-items'] });
    expect(r.status).toBe('partial');
    await page.context().close();
  });

  it('subpasta que abre a pasta errada: interrompe sem novos cliques', async () => {
    const page = await open(TREE, 'root', { misrouteTo: { b: 'c' } });
    const r = await scanTree(createAirTreeNavigator(page, {}, { ...NAV, timeoutMs: 800 }), WIDE);
    expect(r).toMatchObject({ status: 'failed', abort: { reason: 'navigation-lost' } });
    expect(r.folders.find((f) => f.name === 'B')?.reasons).toEqual(['navigation-lost']);
    // Assinatura diagnóstica segura: URL mudou, título não confere (outra pasta).
    expect(r.abort?.diagnostic).toMatchObject({ code: 'timeout', checks: { conditions: { urlChanged: true, titleMatches: false } } });
    const report = JSON.stringify(diagnosticReport(r));
    expect(report).toContain('titleMatches');
    for (const s of ['Setor', 'fixture.test', 'my-air']) expect(report).not.toContain(s);
    expect(await read<string[]>(page, '__visits')).toEqual(['a', 'a1', 'root', 'c']); // parou na pasta errada
    await page.context().close();
  });

  it('falha ao voltar: interrompe e preserva o diagnóstico', async () => {
    // "C" está no 2º nível: volta pelo breadcrumb funciona; força o 3º nível, onde a volta usa o "voltar".
    const page = await open(TREE, 'root', { backTo: 'b' });
    const r = await scanTree(createAirTreeNavigator(page, {}, { ...NAV, timeoutMs: 800 }), WIDE);
    expect(r).toMatchObject({ status: 'failed', abort: { reason: 'return-failed' } });
    expect(r.folders.find((f) => f.name === 'A1')).toMatchObject({ status: 'complete' });
    expect(r.folders.find((f) => f.name === 'A')?.reasons).toContain('return-failed');
    expect(r.folders.find((f) => f.name === 'E')?.reasons).toEqual(['run-aborted']);
    await page.context().close();
  });

  it('regressão AIR real: linha com "Caminho" de outro ramo não é aberta; a pasta é confirmada pelas demais', async () => {
    const root = dir('root', 'Setor', [
      dir('a', 'A', [dir('ok', 'Ok', files('ok', 1)), { ...dir('mov', 'Movida', files('mov', 1)), pathOverride: '/Outro/Ramo' }, ...files('a', 1)]),
    ]);
    const page = await open(root, 'root', { pageSize: 30 });
    const r = await scanTree(createAirTreeNavigator(page, {}, NAV), WIDE);
    expect(await read<string[]>(page, '__visits')).toEqual(['a', 'ok', 'root']);
    expect(r.folders.map((f) => [f.name, f.status, f.subtreeStatus, f.reasons])).toEqual([
      ['Setor', 'complete', 'partial', []],
      ['A', 'complete', 'partial', ['location-mismatch']],
      ['Ok', 'complete', 'complete', []],
      ['Movida', 'skipped', 'skipped', ['location-mismatch']],
    ]);
    expect(r.folders[1]?.counts.locationMismatch).toBe(1);
    expect(r.status).toBe('partial');
    await page.context().close();
  });

  it('pasta inicial com "Caminho" divergente: caminho esperado vem do título (raiz) ou do breadcrumb completo (2º nível)', async () => {
    const odd = (id: string) => ({ ...dir(id, `Mov ${id}`), pathOverride: '/Outro' });
    const root = dir('root', 'Setor', [dir('a', 'A', [dir('a1', 'A1'), odd('m2')]), odd('m1')]);
    for (const [start, startName] of [['root', 'Setor'], ['a', 'A']] as const) {
      const page = await open(root, start, { pageSize: 30 });
      const r = await scanTree(createAirTreeNavigator(page, {}, NAV), WIDE);
      expect(r.folders[0]).toMatchObject({ name: startName, status: 'complete', reasons: ['location-mismatch'] });
      expect(r.folders.filter((f) => f.reasons.includes('location-mismatch') && f.status === 'skipped').length).toBeGreaterThan(0);
      expect((await read<string[]>(page, '__visits')) ?? []).not.toContain('m1');
      await page.context().close();
    }
  });

  it('pasta inicial no 3º nível (breadcrumb colapsado) com "Caminho" divergente: não inicia e não clica', async () => {
    const root = dir('root', 'Setor', [dir('a', 'A', [dir('deep', 'Deep', [dir('x', 'X'), { ...dir('y', 'Y'), pathOverride: '/Outro' }])])]);
    const page = await open(root, 'deep', { pageSize: 30 });
    await expect(scanTree(createAirTreeNavigator(page, {}, NAV), WIDE)).rejects.toThrow(/Caminho" com valores diferentes/);
    expect(await read<string[]>(page, '__visits')).toEqual([]);
    await page.context().close();
  });

  it('regressão AIR real: paginador com reticências ([1][2][...][N]) continua navegável', async () => {
    const root = dir('root', 'Setor', [dir('big', 'Grande', files('g', 17)), ...files('s', 9)]);
    const page = await open(root, 'root', { pageSize: 2 });
    const r = await scanTree(createAirTreeNavigator(page, {}, NAV), WIDE);
    expect(await page.locator('#pager span').count()).toBe(1); // as reticências estão na tela
    expect(r.folders.map((f) => [f.name, f.status, f.counts.items, f.counts.pagesRead])).toEqual([
      ['Setor', 'complete', 10, 5],
      ['Grande', 'complete', 17, 9],
    ]);
    expect(r.status).toBe('complete');
    expect(await read<string[]>(page, '__forbiddenClicks')).toEqual([]);
    await page.context().close();
  });

  it('retomada pela UI: interrompida, retoma da mesma pasta inicial sem reabrir subárvores assentadas', async () => {
    const pseudonymize = (v: string) => createHmac('sha256', 'k').update(v).digest('hex').slice(0, 32);
    let saved: CheckpointFolder[] = [];
    const checkpoint = { pseudonymize, save: async (s: TreeCheckpointSnapshot) => void (saved = s.folders) };

    const first = await open(TREE, 'root', { misrouteTo: { b: 'c' } });
    const r1 = await scanTree(createAirTreeNavigator(first, {}, { ...NAV, timeoutMs: 800 }), WIDE, { checkpoint });
    expect(r1).toMatchObject({ status: 'failed', abort: { reason: 'navigation-lost' } });
    await first.context().close();

    // O operador abre de novo a pasta inicial (aqui, a fixture já começa nela).
    const second = await open(TREE, 'root', { renderDelayMs: 30 });
    const r2 = await scanTree(createAirTreeNavigator(second, {}, NAV), WIDE, { checkpoint: { ...checkpoint, resume: { from: saved, mode: 'fast' } } });
    expect(r2.status).toBe('complete');
    expect(r2.resume?.reusedFolders).toBe(2); // A e A1
    expect(await read<string[]>(second, '__visits')).toEqual(['b', 'root', 'c', 'root', 'e', 'e1', 'root']);
    expect(await read<string[]>(second, '__forbiddenClicks')).toEqual([]);
    expect(r2.totals).toMatchObject({ foldersRead: 7, items: 13 });
    await second.context().close();
  });

  it('retomada VERIFICADA pela UI: reabre todas as pastas e é elegível para planejamento', async () => {
    const pseudonymize = (v: string) => createHmac('sha256', 'k').update(v).digest('hex').slice(0, 32);
    let saved: CheckpointFolder[] = [];
    const checkpoint = { pseudonymize, save: async (s: TreeCheckpointSnapshot) => void (saved = s.folders) };
    const first = await open(TREE, 'root', { misrouteTo: { b: 'c' } });
    await scanTree(createAirTreeNavigator(first, {}, { ...NAV, timeoutMs: 800 }), WIDE, { checkpoint });
    await first.context().close();

    const second = await open(TREE, 'root');
    const r = await scanTree(createAirTreeNavigator(second, {}, NAV), WIDE, { checkpoint: { ...checkpoint, resume: { from: saved, mode: 'verified' } } });
    expect(r.status).toBe('complete');
    expect(r.resume).toMatchObject({ mode: 'verified', reusedFolders: 0 });
    expect(r.verification.eligibleForPlanning).toBe(true);
    expect(await read<string[]>(second, '__visits')).toEqual(['a', 'a1', 'root', 'b', 'root', 'c', 'root', 'e', 'e1', 'root']);
    expect(await read<string[]>(second, '__forbiddenClicks')).toEqual([]);
    await second.context().close();
  });

  it('achado real POC-01E: se paginar criar entrada no histórico, a volta pelo "voltar" do 3º nível falha fechada', async () => {
    // A1 (3º nível, 2 páginas) volta pelo "voltar" (histórico), porque o pai está colapsado no breadcrumb.
    const page = await open(TREE, 'root', { pagingPushesHistory: true });
    const r = await scanTree(createAirTreeNavigator(page, {}, { ...NAV, timeoutMs: 800 }), WIDE);
    expect(r).toMatchObject({ status: 'failed', abort: { reason: 'return-failed' } });
    expect(r.folders.find((f) => f.name === 'A')?.reasons).toContain('return-failed');
    expect(await read<string[]>(page, '__visits')).toEqual(['a', 'a1']); // nenhum clique depois da falha
    expect(await read<string[]>(page, '__forbiddenClicks')).toEqual([]);
    await page.context().close();
  });

  it('ADR-013 pelo adaptador real: pai alterado durante a leitura vira content-changed, sem cliques na listagem antiga', async () => {
    // Ao abrir A, o item E some da pasta inicial: na volta, a identidade confere e o total não.
    const page = await open(TREE, 'root', { mutateOnVisit: { a: 'e' } });
    const r = await scanTree(createAirTreeNavigator(page, {}, NAV), WIDE);
    expect(r.status).toBe('partial');
    expect(r.abort).toBeUndefined();
    expect(r.navigation).toEqual({ contentChanged: 1, identityMismatch: 0, navigationFailed: 0 });
    expect(r.folders[0]).toMatchObject({ status: 'partial', subtreeStatus: 'partial', reasons: ['content-changed'] });
    expect(r.folders.filter((f) => ['B', 'C', 'E'].includes(f.name ?? '')).map((f) => f.reasons)).toEqual([['content-changed'], ['content-changed'], ['content-changed']]);
    expect(await read<string[]>(page, '__visits')).toEqual(['a', 'a1', 'root']); // nada aberto depois
    expect(await read<string[]>(page, '__forbiddenClicks')).toEqual([]);
    expect(r.verification.eligibleForPlanning).toBe(false);
    await page.context().close();
  });

  it('logs e relatório diagnóstico padrão não expõem nomes, caminhos ou URLs', async () => {
    const root = dir('root', 'SETOR FICTICIO REGISTROS', [dir('p', 'BELTRANA DE TAL 111.222.333-44', files('CICRANO REG 00000', 3))]);
    const page = await open(root, 'root');
    const lines: string[] = [];
    const r = await scanTree(createAirTreeNavigator(page, {}, NAV), WIDE, { onEvent: (e) => lines.push(formatTreeEvent(e)) });
    expect(r.status).toBe('complete');
    const exposed = `${lines.join('\n')}\n${JSON.stringify(diagnosticReport(r))}`;
    for (const s of ['FICTICIO', 'BELTRANA', '111.222', 'CICRANO', 'REG 00000', 'fixture.test', 'my-air']) expect(exposed).not.toContain(s);
    await page.context().close();
  });
});
