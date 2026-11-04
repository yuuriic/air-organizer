import { createHmac } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFolderContext } from '../../src/air/folders.js';
import { createAirTreeNavigator } from '../../src/air/tree-navigator.js';
import { ResumeRejectedError, type CheckpointFolder } from '../../src/core/checkpoint.js';
import { scanTree } from '../../src/core/tree-scanner.js';
import type { TreeLimits } from '../../src/types/inventory.js';
import { airTreeHtml, type TreeFixtureOptions, type TreeNode } from '../fixtures/air-tree.js';

/**
 * Pasta inicial em hierarquia profunda (breadcrumb colapsado) com linhas de "Caminho" de outro ramo.
 * Adaptador real sobre a fixture SINTÉTICA (Chrome headless, origem falsa, nada sai da máquina).
 */
const ORIGIN = 'https://air.fixture.test';
const NAV = { timeoutMs: 5_000, pollMs: 40, readTimeoutMs: 5_000 };
const WIDE: TreeLimits = { maxDepth: 6, maxFolders: 50, maxItems: 1_000, maxPagesPerFolder: 20 };
const pseudonymize = (v: string) => createHmac('sha256', 'k').update(v).digest('hex').slice(0, 32);

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

const dir = (id: string, name: string, children: TreeNode[] = [], pathOverride?: string): TreeNode => ({ id, name, type: 'folder', children, ...(pathOverride ? { pathOverride } : {}) });
const doc = (id: string, pathOverride?: string): TreeNode => ({ id, name: `${id}.pdf`, type: 'file', ...(pathOverride ? { pathOverride } : {}) });

/** Setor / Nivel1 / Nivel2 (3º nível) / Alfa (4º) / Alfa1 (5º). Linhas de outro ramo em Nivel2 e Alfa. */
function tree(l2Extra: TreeNode[] = [], l1Name = 'Nivel1'): TreeNode {
  return dir('root', 'Setor', [
    dir('l1', l1Name, [
      doc('l1doc'),
      doc('l1ext', '/Setor/Outro'),
      dir('l2', 'Nivel2', [
        dir('a', 'Alfa', [dir('a1', 'Alfa1', [doc('a1doc')]), doc('adoc'), doc('aext', '/Setor/Outro')]),
        dir('b', 'Beta', [doc('bdoc')]),
        doc('l2ext', '/Setor/Outro'),
        dir('x', 'Estranha', [doc('xdoc')], '/Setor/Outro'),
        ...l2Extra,
      ]),
    ]),
    dir('ou', 'Outro', [doc('oudoc')]),
  ]);
}

async function open(root: TreeNode, start: string, options: Partial<TreeFixtureOptions> = {}): Promise<Page> {
  if (!browser) throw new Error(`Chrome indisponível para testes: ${String(launchError)}`);
  const context = await browser.newContext();
  const html = airTreeHtml({ root, pageSize: 30, ...options });
  await context.route('**/*', (route) =>
    route.request().url().startsWith(`${ORIGIN}/`) ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort(),
  );
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/air/my-air/${start}`);
  return page;
}
const read = <T>(page: Page, key: string) => page.evaluate((k) => (window as unknown as Record<string, T>)[k], key);

describe('caminho da pasta exibida: origem e recusa', () => {
  it('3º nível, breadcrumb colapsado, caminhos divergentes: candidato único = caminho inferido', async () => {
    const page = await open(tree(), 'l2');
    const ctx = await readFolderContext(page);
    expect(ctx).toMatchObject({ title: 'Nivel2', breadcrumb: ['Setor', '…', 'Nivel2'], path: '/Setor/Nivel1/Nivel2', pathEvidence: 'inferred', pathAnomalies: 2 });
    await page.context().close();
  });

  it('4º nível: também inferido', async () => {
    const page = await open(tree(), 'a');
    expect(await readFolderContext(page)).toMatchObject({ path: '/Setor/Nivel1/Nivel2/Alfa', pathEvidence: 'inferred', pathAnomalies: 1 });
    await page.context().close();
  });

  it('2º nível (breadcrumb expandido) com caminhos divergentes: cadeia do breadcrumb, como antes', async () => {
    const page = await open(tree(), 'l1');
    expect(await readFolderContext(page)).toMatchObject({ path: '/Setor/Nivel1', pathEvidence: 'breadcrumb', pathAnomalies: 1 });
    await page.context().close();
  });

  it('caminhos uniformes: regra atual mantida (uniform)', async () => {
    const page = await open(tree(), 'a1');
    expect(await readFolderContext(page)).toMatchObject({ path: '/Setor/Nivel1/Nivel2/Alfa/Alfa1', pathEvidence: 'uniform' });
    await page.context().close();
  });

  it('dois candidatos igualmente compatíveis: path-divergent, nenhum clique', async () => {
    const page = await open(tree([doc('viz', '/Setor/Outro/Nivel2')]), 'l2');
    await expect(readFolderContext(page)).rejects.toMatchObject({ code: 'path-divergent' });
    await expect(scanTree(createAirTreeNavigator(page, {}, NAV), WIDE)).rejects.toMatchObject({ code: 'path-divergent' });
    expect(await read<string[]>(page, '__visits')).toEqual([]);
    expect(await read<string[]>(page, '__navClicks')).toEqual([]);
    await page.context().close();
  });

  it('nenhum candidato: path-divergent', async () => {
    const root = dir('root', 'Setor', [dir('l1', 'Nivel1', [dir('z', 'Zeta', [doc('p', '/Setor/P'), doc('q', '/Setor/Q')])])]);
    const page = await open(root, 'z');
    await expect(readFolderContext(page)).rejects.toMatchObject({ code: 'path-divergent' });
    await page.context().close();
  });
});

describe('leitura recursiva a partir de pasta profunda', () => {
  it('lê e volta corretamente; itens de outro ramo não são abertos; inventário parcial', async () => {
    const page = await open(tree(), 'l2', { renderDelayMs: 30 });
    const r = await scanTree(createAirTreeNavigator(page, {}, NAV), WIDE);
    expect(await read<string[]>(page, '__visits')).not.toContain('x'); // pasta de outro ramo
    expect(await read<string[]>(page, '__visits')).toEqual(expect.arrayContaining(['a', 'a1', 'b']));
    expect(await read<string[]>(page, '__forbiddenClicks')).toEqual([]);
    expect(r.folders[0]).toMatchObject({ name: 'Nivel2', path: '/Setor/Nivel1/Nivel2', status: 'complete', subtreeStatus: 'partial', reasons: ['location-mismatch'] });
    expect(r.folders.find((f) => f.name === 'Estranha')).toMatchObject({ status: 'skipped', reasons: ['location-mismatch'] });
    expect(r.folders.filter((f) => ['Alfa1', 'Beta'].includes(f.name ?? '')).every((f) => f.status === 'complete')).toBe(true);
    expect(r.status).toBe('partial'); // nunca promovido a completo
    expect(r.verification.eligibleForPlanning).toBe(false);
    expect(page.url()).toBe(`${ORIGIN}/air/my-air/l2`);
    await page.context().close();
  });

  it('pai paginado: mesma regra; nada de outro ramo aberto', async () => {
    const page = await open(tree(), 'l2', { pageSize: 2 });
    const r = await scanTree(createAirTreeNavigator(page, {}, NAV), WIDE);
    expect(await read<string[]>(page, '__visits')).not.toContain('x');
    expect(r.folders[0]!.counts.pagesRead).toBe(2);
    expect(r.status).toBe('partial');
    await page.context().close();
  });

  it('retorno ao pai incorreto em hierarquia profunda: interrompe sem novos cliques', async () => {
    const page = await open(tree(), 'l2', { backTo: 'ou' });
    const r = await scanTree(createAirTreeNavigator(page, {}, { ...NAV, timeoutMs: 800 }), WIDE);
    expect(r).toMatchObject({ status: 'failed', abort: { reason: 'return-failed' } });
    await page.context().close();
  });

  it('subpasta que abre outra pasta (título diferente) ou não muda a URL: navegação perdida', async () => {
    const misrouted = await open(tree(), 'l2', { misrouteTo: { a: 'ou' } });
    const m = await scanTree(createAirTreeNavigator(misrouted, {}, { ...NAV, timeoutMs: 800 }), WIDE);
    expect(m).toMatchObject({ status: 'failed', abort: { reason: 'navigation-lost' } });
    expect(m.abort?.diagnostic?.checks?.conditions).toMatchObject({ urlChanged: true, titleMatches: false });
    await misrouted.context().close();

    const inert = await open(tree(), 'l2', { inertRows: ['a'] });
    const i = await scanTree(createAirTreeNavigator(inert, {}, { ...NAV, timeoutMs: 800 }), WIDE);
    expect(i).toMatchObject({ status: 'failed', abort: { reason: 'navigation-lost' } });
    // O pai continua exibido: a leitura com o caminho esperado da subpasta nunca confere (falha fechada).
    expect(i.abort?.diagnostic).toMatchObject({ code: 'timeout', checks: { readFailures: { 'path-divergent': expect.any(Number) } } });
    expect(i.abort?.diagnostic?.checks?.conditions).toBeUndefined();
    await inert.context().close();
  });

  it('homônimos continuam recusados na política padrão, também com caminho inferido', async () => {
    const page = await open(tree([dir('h1', 'Docs'), dir('h2', 'Docs')]), 'l2');
    const r = await scanTree(createAirTreeNavigator(page, {}, NAV), WIDE);
    expect(r.folders.filter((f) => f.name === 'Docs').map((f) => f.reasons)).toEqual([['homonym'], ['homonym']]);
    expect(await read<string[]>(page, '__visits')).not.toContain('h1');
    await page.context().close();
  });
});

describe('checkpoints com caminho inferido', () => {
  async function firstRun(): Promise<CheckpointFolder[]> {
    let saved: CheckpointFolder[] = [];
    const page = await open(tree(), 'l2');
    await scanTree(createAirTreeNavigator(page, {}, NAV), { ...WIDE, maxFolders: 2 }, { checkpoint: { pseudonymize, save: async (s) => void (saved = s.folders) } });
    await page.context().close();
    return saved;
  }
  const resume = (page: Page, from: CheckpointFolder[]) =>
    scanTree(createAirTreeNavigator(page, {}, NAV), WIDE, { checkpoint: { pseudonymize, save: async () => {}, resume: { from, mode: 'verified' } } });

  it('mesmo conteúdo: retomada aceita (mesmo caminho inferido)', async () => {
    const from = await firstRun();
    const page = await open(tree(), 'l2');
    const r = await resume(page, from);
    expect(r.resume?.mode).toBe('verified');
    expect(r.folders[0]?.verification).toBe('unchanged');
    await page.context().close();
  });

  it('caminho inferido diferente na retomada (nível oculto renomeado): recusa antes de qualquer clique', async () => {
    const from = await firstRun();
    const page = await open(tree([], 'NivelX'), 'l2');
    await expect(resume(page, from)).rejects.toBeInstanceOf(ResumeRejectedError);
    expect(await read<string[]>(page, '__visits')).toEqual([]);
    await page.context().close();
  });

  it('caminho que ficou ambíguo na retomada: recusa antes de qualquer clique', async () => {
    const from = await firstRun();
    const page = await open(tree([doc('viz', '/Setor/Outro/Nivel2')]), 'l2');
    await expect(resume(page, from)).rejects.toMatchObject({ code: 'path-divergent' });
    expect(await read<string[]>(page, '__visits')).toEqual([]);
    await page.context().close();
  });
});
