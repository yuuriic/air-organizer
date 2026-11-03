import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAirListingSource, detectEnvironment, probePagination } from '../../src/air/navigator.js';
import { extractListing } from '../../src/air/reader.js';
import { findDuplicateSuspicions } from '../../src/core/duplicates.js';
import { scanListing } from '../../src/core/scanner.js';
import { fingerprintOf } from '../../src/safety/scope-validator.js';
import { airListingHtml, type FixtureOptions } from '../fixtures/air-listing.js';

/**
 * Usa o Google Chrome instalado (channel 'chrome'), headless, com contexto
 * efêmero — sem perfil do usuário. A origem HTTPS é falsa e respondida por
 * page.route: nenhuma requisição sai da máquina.
 */
const FIXTURE_ORIGIN = 'https://air.fixture.test';

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

async function openFixture(options: FixtureOptions): Promise<Page> {
  if (!browser) throw new Error(`Chrome indisponível para testes: ${String(launchError)}`);
  const context = await browser.newContext();
  await context.route('**/*', (route) =>
    route.request().url().startsWith(`${FIXTURE_ORIGIN}/`)
      ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: airListingHtml(options) })
      : route.abort(),
  );
  const page = await context.newPage();
  await page.goto(`${FIXTURE_ORIGIN}/setores/teste/pastas?sessao=segredo#raiz`);
  return page;
}

function forbiddenClicks(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __forbiddenClicks: string[] }).__forbiddenClicks);
}

/**
 * 18 nomes SINTÉTICOS com as características que os testes exigem: pares que diferem só por
 * caixa (PLANETAS/Planetas, COMETAS/Cometas) ou por acento (ORBITAS/ÓRBITAS), um par com
 * acento e palavras diferentes que NÃO é duplicidade, um par com sufixo numérico que só pede
 * revisão (Catalogo/Catalogo-2031) e um arquivo.
 */
const SYNTHETIC_NAMES = [
  'PLANETAS', 'Planetas', 'ORBITAS', 'ÓRBITAS', 'COMETAS', 'Cometas',
  'OBSERVAÇÕES NOTURNAS', 'Observacao de Nebulosas', 'Catalogo', 'Catalogo-2031',
  'Asteroides', 'Constelações', 'Eclipses', 'Galáxias', 'Meteoros', 'Nebulosas', 'Satélites', 'relatorio.pdf',
];

describe('AIR reader/navigator sobre fixture HTML', () => {
  it('extrai as 18 linhas, colunas e metadados da listagem', async () => {
    const page = await openFixture({ names: SYNTHETIC_NAMES, pageSize: 30 });
    const listing = await extractListing(page);
    expect(listing.headers.slice(1)).toEqual(['Nome', 'Descrição', 'Caminho', 'Data criação', 'Status']);
    expect(listing.rows).toHaveLength(18);
    expect(listing.reportedTotal).toBe(18);
    expect(listing.pageIndicator).toBe('Página 1 de 1');
    expect(listing.rows[0]?.cells.Nome).toBe('PLANETAS');
    expect(listing.rows[0]?.idCandidates).toEqual({ 'data-row-id': 'r0' });
    await page.context().close();
  });

  it('identifica ambiente sem query string e sem inventar cliente/setor', async () => {
    const page = await openFixture({ names: SYNTHETIC_NAMES, pageSize: 30, breadcrumb: ['Setor Teste', 'Raiz', 'Sub'] });
    const env = await detectEnvironment(page, {});
    expect(env.instanceOrigin).toEqual({ status: 'identified', value: FIXTURE_ORIGIN, source: 'url' });
    expect(env.pageUrl).toMatchObject({ value: `${FIXTURE_ORIGIN}/setores/teste/pastas` });
    expect(env.breadcrumb).toMatchObject({ value: ['Setor Teste', 'Raiz', 'Sub'] });
    expect(env.currentFolder).toMatchObject({ value: 'Sub' });
    expect(env.client.status).toBe('not-identified');
    expect(env.sector.status).toBe('not-identified');
    await page.context().close();
  });

  it('percorre a paginação com carregamento assíncrono sem omissões nem repetições', async () => {
    const names = Array.from({ length: 65 }, (_, i) => `Pasta ${String(i + 1).padStart(3, '0')}`);
    const page = await openFixture({ names, pageSize: 30, renderDelayMs: 400 });
    const env = await detectEnvironment(page, { sector: 'Setor Teste' });
    const source = createAirListingSource(page, fingerprintOf(env), { sector: 'Setor Teste' }, { timeoutMs: 5_000, pollMs: 100 });
    const { items, coverage } = await scanListing(source, { maxPages: 10, readTimeoutMs: 5_000 });

    expect(items.map((i) => i.name)).toEqual(names);
    expect(coverage).toMatchObject({ pagesRead: 3, expectedPages: 3, uniqueItems: 65, repeatedObservations: 0, complete: true, stopReason: 'last-page' });
    expect(items.every((i) => i.kind === 'folder')).toBe(true);
    expect(await forbiddenClicks(page)).toEqual([]);
    await page.context().close();
  });

  it('detecta suspeitas de duplicidade dos pares sintéticos e nunca clica em controles proibidos', async () => {
    const page = await openFixture({ names: SYNTHETIC_NAMES, pageSize: 30 });
    const env = await detectEnvironment(page, {});
    const source = createAirListingSource(page, fingerprintOf(env), {}, { timeoutMs: 2_000, pollMs: 100 });
    const { items, coverage } = await scanListing(source, { maxPages: 10, readTimeoutMs: 2_000 });
    expect(coverage.complete).toBe(true);
    expect(items.find((i) => i.name === 'relatorio.pdf')?.kind).toBe('file');
    const groups = findDuplicateSuspicions(items).map((s) => s.normalizedName);
    expect(groups).toEqual(['cometas', 'orbitas', 'planetas']);
    expect(await forbiddenClicks(page)).toEqual([]);
    await page.context().close();
  });

  it('reporta página inalterada quando o botão Próxima não tem efeito', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `Item ${i}`);
    const page = await openFixture({ names, pageSize: 30, mode: 'stuck' });
    const env = await detectEnvironment(page, {});
    const source = createAirListingSource(page, fingerprintOf(env), {}, { timeoutMs: 800, pollMs: 100 });
    const { coverage } = await scanListing(source, { maxPages: 10, readTimeoutMs: 2_000 });
    expect(coverage).toMatchObject({ pagesRead: 1, complete: false, unreadPages: [] });
    expect(coverage.issues.map((i) => i.kind)).toContain('page-unchanged');
    await page.context().close();
  });

  it('detecta loop quando a paginação volta ao início', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `Item ${i}`);
    const page = await openFixture({ names, pageSize: 30, mode: 'loop' });
    const env = await detectEnvironment(page, {});
    const source = createAirListingSource(page, fingerprintOf(env), {}, { timeoutMs: 2_000, pollMs: 100 });
    const { items, coverage } = await scanListing(source, { maxPages: 10, readTimeoutMs: 2_000 });
    expect(items).toHaveLength(40);
    expect(coverage.stopReason).toBe('loop');
    expect(coverage.complete).toBe(false);
    await page.context().close();
  });

  it('localiza o botão de próxima página sem clicar', async () => {
    const page = await openFixture({ names: SYNTHETIC_NAMES, pageSize: 30 });
    expect(await probePagination(page)).toEqual({ status: 'found', label: 'Próxima página', disabled: true });
    await page.context().close();
  });
});

/** Estrutura observada no AIR real na POC-01B ("Meu Air", 37 itens, páginas de 30). */
describe('AIR reader/navigator sobre fixture com a estrutura real do AIR', () => {
  const REAL_NAMES = Array.from({ length: 37 }, (_, i) => `Pasta ${String(i + 1).padStart(2, '0')}`);
  const realFixture = { names: REAL_NAMES, pageSize: 30, breadcrumb: ['Meu Air'], variant: 'air-real' as const };

  it('lê o total do título e trata "X de N linhas(s)" como contagem da página', async () => {
    const page = await openFixture(realFixture);
    const listing = await extractListing(page);
    expect(listing.rows).toHaveLength(30);
    expect(listing).toMatchObject({ reportedTotal: 37, folderTitle: 'Meu Air', pageRowCounter: 30, pageIndicator: 'página ativa 1' });
    await page.context().close();
  });

  it('sem breadcrumb, identifica a pasta atual pelo título', async () => {
    const page = await openFixture(realFixture);
    const env = await detectEnvironment(page, {});
    expect(env.breadcrumb.status).toBe('not-identified');
    expect(env.currentFolder).toEqual({ status: 'identified', value: 'Meu Air', source: 'page-heading' });
    await page.context().close();
  });

  it('identifica a próxima página pelo ícone no paginador e ignora o mesmo ícone no carrossel', async () => {
    const page = await openFixture(realFixture);
    expect(await probePagination(page)).toEqual({ status: 'found', label: 'icon:chevron-right', disabled: false });
    await page.context().close();
  });

  it('lê as 2 páginas (37 itens) como completas sem clicar em controles proibidos', async () => {
    const page = await openFixture({ ...realFixture, renderDelayMs: 300 });
    const env = await detectEnvironment(page, {});
    const source = createAirListingSource(page, fingerprintOf(env), {}, { timeoutMs: 5_000, pollMs: 100 });
    const { items, coverage } = await scanListing(source, { maxPages: 10, readTimeoutMs: 5_000 });
    expect(items.map((i) => i.name)).toEqual(REAL_NAMES);
    expect(coverage).toMatchObject({ pagesRead: 2, expectedPages: 2, uniqueItems: 37, reportedTotal: 37, complete: true, stopReason: 'last-page' });
    expect(coverage.issues).toEqual([]);
    expect(await forbiddenClicks(page)).toEqual([]);
    expect(await probePagination(page)).toEqual({ status: 'found', label: 'icon:chevron-right', disabled: true });
    await page.context().close();
  });

  it('recusa o ícone de seta quando ele não está em um paginador numérico', async () => {
    const page = await openFixture(realFixture);
    await page.evaluate(() => document.getElementById('pager')?.remove());
    expect(await probePagination(page)).toEqual({ status: 'rejected', reason: expect.stringMatching(/fora de um paginador/) });
    await page.context().close();
  });

});
