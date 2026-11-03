import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityDiagnostic, listVisibleSubfolders, openSubfolder, readFolderContext, returnToParent, type FolderContext } from '../../src/air/folders.js';
import { createAirListingSource, detectEnvironment } from '../../src/air/navigator.js';
import { createAirTreeNavigator } from '../../src/air/tree-navigator.js';
import { scanListing } from '../../src/core/scanner.js';
import { scanTree } from '../../src/core/tree-scanner.js';
import { fingerprintOf } from '../../src/safety/scope-validator.js';
import type { TreeLimits } from '../../src/types/inventory.js';
import { airTreeHtml, type TreeFixtureOptions, type TreeNode } from '../fixtures/air-tree.js';

/**
 * Achado real da POC-01E: o "voltar" do AIR MANTÉM a página corrente. Voltar de uma subpasta na
 * página 2 exibiu o pai (de página única) sem página ativa e sem linhas, com o total intacto — e a
 * conferência anterior aceitava esse retorno. Correção: reposicionar a subpasta antes de voltar e
 * recusar um pai fora da página esperada ou vazio com total positivo.
 */
const ORIGIN = 'https://air.fixture.test';
const NAV = { timeoutMs: 3_000, pollMs: 40, readTimeoutMs: 3_000 };

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

/** Raiz → Setor (2º nível) → [Lote (3º nível, 35 arquivos = 2 páginas de 30), Outra, Vazia]. */
const ROOT = dir('root', 'Meu Air', [dir('setor', 'Setor', [dir('lote', 'Lote', files('l', 35)), dir('outra', 'Outra', files('o', 1)), dir('vazia', 'Vazia')])]);

async function open(options: Partial<TreeFixtureOptions> = {}, start = 'setor'): Promise<Page> {
  if (!browser) throw new Error(`Chrome indisponível para testes: ${String(launchError)}`);
  const context = await browser.newContext();
  const html = airTreeHtml({ root: ROOT, ...options });
  await context.route('**/*', (route) =>
    route.request().url().startsWith(`${ORIGIN}/`) ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort(),
  );
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/air/my-air/${start}`);
  return page;
}

const read = <T>(page: Page, key: string) => page.evaluate((k) => (window as unknown as Record<string, T>)[k], key);

/** Abre "Lote" a partir de "Setor" e lê as duas páginas (termina na página 2). */
async function openPagedChild(page: Page): Promise<{ parent: FolderContext; child: FolderContext }> {
  const parent = await readFolderContext(page);
  const target = (await listVisibleSubfolders(page, parent)).find((c) => c.name === 'Lote')!;
  const { child } = await openSubfolder(page, parent, target, NAV);
  const env = await detectEnvironment(page, {});
  const scan = await scanListing(createAirListingSource(page, fingerprintOf(env), {}, NAV), { maxPages: 5, readTimeoutMs: 3_000 });
  expect(scan.coverage).toMatchObject({ pagesRead: 2, complete: true });
  return { parent, child };
}

describe('retorno ao pai depois de paginar a subpasta (3º nível)', () => {
  it('AIR mantém a página no "voltar": a subpasta volta à página 1 antes, e o pai é exibido na página esperada', async () => {
    const page = await open({ retainPageOnBack: true });
    const { parent, child } = await openPagedChild(page);
    const back = await returnToParent(page, child, parent, NAV);
    expect(back.restored).toMatchObject({ title: 'Setor', activePage: 1, rows: 3, total: 3 });
    expect(back.contentChanged).toBeUndefined();
    expect(await read<string[]>(page, '__navClicks')).toEqual(['page:1', 'back']); // reposiciona, depois UMA volta
    expect(await read<string[]>(page, '__forbiddenClicks')).toEqual([]);
    await page.context().close();
  });

  it('pai sem página ativa e sem linhas, com total positivo: recusa (empty-listing), navegação falha fechada', async () => {
    const page = await open({ backLandsOnPage: 2 });
    const { parent, child } = await openPagedChild(page);
    const error = await returnToParent(page, child, parent, NAV).then(() => undefined, (e: unknown) => e);
    expect(identityDiagnostic(error)).toEqual({
      category: 'navigation-failed',
      code: 'empty-listing',
      checks: { observations: 1, conditions: { activePage: false, rowsPresent: false }, readFailures: {}, unstable: 0 },
    });
    await page.context().close();
  });

  it('pai em outra página ativa, com linhas: recusa (page-mismatch) — listagem incomparável nunca é aceita', async () => {
    const page = await open({ backLandsOnPage: 2, pageSize: 2 }); // Setor: 3 filhos = 2 páginas de 2
    const parent = await readFolderContext(page);
    const target = (await listVisibleSubfolders(page, parent)).find((c) => c.name === 'Lote')!;
    const { child } = await openSubfolder(page, parent, target, NAV);
    const error = await returnToParent(page, child, parent, NAV).then(() => undefined, (e: unknown) => e);
    expect(identityDiagnostic(error)).toMatchObject({ category: 'navigation-failed', code: 'page-mismatch', checks: { conditions: { activePage: false, rowsPresent: true } } });
    await page.context().close();
  });

  it('subpasta que não volta à página registrada: recusa antes de clicar no "voltar"', async () => {
    const page = await open({ retainPageOnBack: true });
    const { parent, child } = await openPagedChild(page);
    await page.evaluate(() => {
      const cfg = (window as unknown as { __cfg: { root: TreeNode } }).__cfg;
      cfg.root.children![0]!.children![0]!.children![0]!.name = 'alterado.pdf'; // página 1 de "Lote" mudou
    });
    const error = await returnToParent(page, child, parent, NAV).then(() => undefined, (e: unknown) => e);
    expect(identityDiagnostic(error)).toMatchObject({ category: 'navigation-failed', code: 'child-reposition-failed' });
    expect(await read<string[]>(page, '__navClicks')).not.toContain('back');
    await page.context().close();
  });

  it('identidade correta e listagem inconsistente na mesma página: content-changed (ADR-013), não aceita como igual', async () => {
    const page = await open({ retainPageOnBack: true });
    const { parent, child } = await openPagedChild(page);
    await page.evaluate(() => {
      const cfg = (window as unknown as { __cfg: { root: TreeNode } }).__cfg;
      cfg.root.children![0]!.children![1]!.name = 'Outra renomeada';
    });
    const back = await returnToParent(page, child, parent, NAV);
    expect(back.contentChanged).toEqual({ total: false, listing: true });
    await page.context().close();
  });
});

describe('leitura recursiva com o "voltar" que mantém a página', () => {
  const WIDE: TreeLimits = { maxDepth: 3, maxFolders: 20, maxItems: 1_000, maxPagesPerFolder: 5 };

  it('com a correção, a subárvore inteira é lida e cada volta encontra o pai na página 1', async () => {
    const page = await open({ retainPageOnBack: true });
    const r = await scanTree(createAirTreeNavigator(page, {}, NAV), WIDE);
    expect(r.status).toBe('complete');
    expect(r.folders.map((f) => [f.name, f.status])).toEqual([
      ['Setor', 'complete'],
      ['Lote', 'complete'],
      ['Outra', 'complete'],
      ['Vazia', 'complete'],
    ]);
    expect(r.navigation).toEqual({ contentChanged: 0, identityMismatch: 0, navigationFailed: 0 });
    expect(await read<string[]>(page, '__visits')).toEqual(['lote', 'outra', 'vazia']); // voltas pelo histórico
    await page.context().close();
  });

  it('pai fora da página esperada na volta: interrompe sem novos cliques e sem completude', async () => {
    const page = await open({ backLandsOnPage: 2 });
    const r = await scanTree(createAirTreeNavigator(page, {}, NAV), WIDE);
    expect(r).toMatchObject({ status: 'failed', abort: { reason: 'return-failed', diagnostic: { category: 'navigation-failed', code: 'empty-listing' } } });
    expect(r.navigation).toEqual({ contentChanged: 0, identityMismatch: 0, navigationFailed: 1 });
    expect(await read<string[]>(page, '__visits')).toEqual(['lote']); // nada aberto depois
    expect(r.folders.filter((f) => ['Outra', 'Vazia'].includes(f.name ?? '')).map((f) => f.reasons)).toEqual([['run-aborted'], ['run-aborted']]);
    expect(r.verification.eligibleForPlanning).toBe(false);
    await page.context().close();
  });
});
