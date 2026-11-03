import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAirListingSource, detectEnvironment, goToPageNumber } from '../../src/air/navigator.js';
import { createAirTreeNavigator } from '../../src/air/tree-navigator.js';
import { scanListing } from '../../src/core/scanner.js';
import { scanTree } from '../../src/core/tree-scanner.js';
import { fingerprintOf } from '../../src/safety/scope-validator.js';
import type { ScanResult } from '../../src/types/inventory.js';
import { airTreeHtml, type TreeNode } from '../fixtures/air-tree.js';

/**
 * Paginador com reticências (POC-01E), no padrão observado no AIR real: com páginas de 2 itens,
 * "Setor" tem 6 páginas; na página 1 o paginador mostra [1][2][...][6] e, na 6, [1][...][5][6].
 */
const ORIGIN = 'https://air.fixture.test';
const NAV = { timeoutMs: 5_000, pollMs: 40, readTimeoutMs: 5_000 };

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

const file = (id: string): TreeNode => ({ id, name: `${id}.pdf`, type: 'file' });
const dir = (id: string, name: string, children: TreeNode[] = []): TreeNode => ({ id, name, type: 'folder', children });
/** "Primeira" na página 1; "Alvo" na página 5 (oculta pelas reticências). */
const ROOT = dir('root', 'Setor', [
  dir('primeira', 'Primeira', [file('p1')]),
  ...['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map(file),
  dir('alvo', 'Alvo', [file('a1')]),
  ...['s8', 's9', 's10'].map(file),
]);

async function open(): Promise<Page> {
  if (!browser) throw new Error(`Chrome indisponível para testes: ${String(launchError)}`);
  const context = await browser.newContext();
  const html = airTreeHtml({ root: ROOT, pageSize: 2 });
  await context.route('**/*', (route) =>
    route.request().url().startsWith(`${ORIGIN}/`) ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort(),
  );
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/air/my-air/root`);
  return page;
}

const read = <T>(page: Page, key: string) => page.evaluate((k) => (window as unknown as Record<string, T>)[k], key);

/** Lê todas as páginas (termina na última) e devolve as assinaturas registradas. */
async function scanAll(page: Page): Promise<ScanResult> {
  const env = await detectEnvironment(page, {});
  return scanListing(createAirListingSource(page, fingerprintOf(env), {}, NAV), { maxPages: 20, readTimeoutMs: 5_000 });
}

describe('paginação avançada (reticências)', () => {
  it('o paginador esconde as páginas intermediárias', async () => {
    const page = await open();
    expect(await page.locator('#pager > button.border, #pager > button.bg-primary').allTextContents()).toEqual(['1', '2', '6']);
    expect(await page.locator('#pager > span').count()).toBe(1);
    await page.context().close();
  });

  it('alcança página oculta a partir da última: número visível mais próximo e depois "próxima", sem tocar nas reticências', async () => {
    const page = await open();
    const scan = await scanAll(page); // termina na página 6
    expect(scan.coverage).toMatchObject({ pagesRead: 6, complete: true });
    // Visíveis na 6: [1][5][6]. Cada clique desloca a janela (atual ± 1), então os números bastam.
    const jump = await goToPageNumber(page, 3, scan.pages[2]!.signature, NAV);
    expect(jump).toEqual({ status: 'reached', clicks: 3 });
    expect(await read<string[]>(page, '__navClicks')).toEqual(['page:1', 'page:2', 'page:3']);
    expect(await read<string[]>(page, '__forbiddenClicks')).toEqual([]);
    await page.context().close();
  });

  it('alcança página oculta a partir da página 1 e página visível com um clique', async () => {
    const page = await open();
    const scan = await scanAll(page);
    expect(await goToPageNumber(page, 1, scan.pages[0]!.signature, NAV)).toEqual({ status: 'reached', clicks: 1 });
    expect(await goToPageNumber(page, 4, scan.pages[3]!.signature, NAV)).toEqual({ status: 'reached', clicks: 3 }); // [2] + 2× próxima
    expect(await read<string[]>(page, '__forbiddenClicks')).toEqual([]);
    await page.context().close();
  });

  it('conteúdo da página mudou desde a leitura: recusa', async () => {
    const page = await open();
    const scan = await scanAll(page);
    await page.evaluate(() => {
      const cfg = (window as unknown as { __cfg: { root: { children: Array<{ name: string }> } } }).__cfg;
      cfg.root.children[9]!.name = 'renomeado.pdf'; // página 5
    });
    const jump = await goToPageNumber(page, 5, scan.pages[4]!.signature, NAV);
    expect(jump).toMatchObject({ status: 'failed', reason: expect.stringMatching(/difere do lido antes/) });
    await page.context().close();
  });

  it('botão numérico que leva à página errada: a página esperada não é confirmada e nada mais é clicado', async () => {
    const page = await open();
    const scan = await scanAll(page);
    await goToPageNumber(page, 1, scan.pages[0]!.signature, NAV);
    await page.evaluate(() => ((window as unknown as { __pageOffset: number }).__pageOffset = 1));
    const jump = await goToPageNumber(page, 4, scan.pages[3]!.signature, { ...NAV, timeoutMs: 800 });
    expect(jump).toMatchObject({ status: 'failed', clicks: 1, reason: expect.stringMatching(/página 2 não foi confirmada/) });
    await page.context().close();
  });

  it('scanner: página ativa diferente da esperada torna a leitura parcial', async () => {
    const page = await open();
    await page.evaluate(() => ((window as unknown as { __nextStep: number }).__nextStep = 2));
    const scan = await scanAll(page);
    expect(scan.coverage).toMatchObject({ complete: false, stopReason: 'error', pagesRead: 1 });
    expect(scan.coverage.issues.map((i) => i.kind)).toContain('page-mismatch');
    await page.context().close();
  });

  it('leitura recursiva abre a subpasta da página oculta (antes ficava pendente)', async () => {
    const page = await open();
    const r = await scanTree(createAirTreeNavigator(page, {}, NAV), { maxDepth: 2, maxFolders: 10, maxItems: 100, maxPagesPerFolder: 10 });
    expect(r.status).toBe('complete');
    expect(r.folders.map((f) => [f.name, f.status])).toEqual([
      ['Setor', 'complete'],
      ['Primeira', 'complete'],
      ['Alvo', 'complete'],
    ]);
    expect(await read<string[]>(page, '__visits')).toEqual(['primeira', 'root', 'alvo', 'root']);
    expect(await read<string[]>(page, '__navClicks')).toContain('page:2');
    expect(await read<string[]>(page, '__forbiddenClicks')).toEqual([]);
    await page.context().close();
  });
});
