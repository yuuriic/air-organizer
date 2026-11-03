import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FolderIdentityError, NavigationLostError, identityDiagnostic, listVisibleSubfolders, openSubfolder, readFolderContext, returnToParent } from '../../src/air/folders.js';
import { createAirListingSource, detectEnvironment, probePagination } from '../../src/air/navigator.js';
import { extractListing, parseRows } from '../../src/air/reader.js';
import { scanListing } from '../../src/core/scanner.js';
import { SafetyViolation, fingerprintOf } from '../../src/safety/scope-validator.js';
import { airTreeHtml, type TreeFixtureOptions, type TreeNode } from '../fixtures/air-tree.js';

/** Chrome instalado, headless, contexto efêmero; origem HTTPS falsa via route. Nada sai da máquina. */
const ORIGIN = 'https://air.fixture.test';
const NAV = { timeoutMs: 5_000, pollMs: 50 };

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

const TREE: TreeNode = {
  id: 'root',
  name: 'Meu Air',
  type: 'folder',
  children: [
    {
      id: 'alfa',
      name: 'Setor Exemplo - Unidade Alfa',
      type: 'folder',
      children: [
        { id: 'beta', name: 'lote beta', type: 'folder', children: [...files('doc', 3), { id: 'sub', name: 'Sub', type: 'folder', children: [] }] },
        { id: 'regs', name: 'registros fulano', type: 'folder', children: files('reg', 35) },
        { id: 'vazia', name: 'vazia', type: 'folder', children: [] },
      ],
    },
    { id: 'editoriais', name: 'Editoriais', type: 'folder', children: files('editorial', 2) },
    { id: 'leia', name: 'leia-me.pdf', type: 'file' },
    { id: 'other', name: 'Outra', type: 'folder', children: [] },
  ],
};

async function open(start: string, options: Partial<TreeFixtureOptions> = {}): Promise<Page> {
  if (!browser) throw new Error(`Chrome indisponível para testes: ${String(launchError)}`);
  const context = await browser.newContext();
  const html = airTreeHtml({ root: TREE, ...options });
  await context.route('**/*', (route) =>
    route.request().url().startsWith(`${ORIGIN}/`) ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort(),
  );
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/air/my-air/${start}`);
  return page;
}

const navClicks = (page: Page) => page.evaluate(() => (window as unknown as { __navClicks: string[] }).__navClicks);
const forbiddenClicks = (page: Page) => page.evaluate(() => (window as unknown as { __forbiddenClicks: string[] }).__forbiddenClicks);

async function subfolder(page: Page, name: string) {
  const parent = await readFolderContext(page);
  const target = (await listVisibleSubfolders(page, parent)).find((c) => c.name === name);
  if (!target) throw new Error(`subpasta ${name} não listada`);
  return { parent, target };
}

describe('navegação controlada em subpastas (fixture com o comportamento do AIR)', () => {
  it('lê a raiz sem breadcrumb e lista só subpastas (arquivo não é candidato)', async () => {
    const page = await open('root');
    const parent = await readFolderContext(page);
    expect(parent).toMatchObject({ title: 'Meu Air', total: 4, path: '/Meu Air', pageUrl: `${ORIGIN}/air/my-air/root` });
    expect(parent.breadcrumb).toBeUndefined();
    const names = (await listVisibleSubfolders(page, parent)).map((c) => c.name);
    expect(names).toEqual(['Setor Exemplo - Unidade Alfa', 'Editoriais', 'Outra']);
    await page.context().close();
  });

  it('abre a subpasta, confirma a identidade, volta pelo breadcrumb e confirma o retorno', async () => {
    const page = await open('root', { renderDelayMs: 150 });
    const { parent, target } = await subfolder(page, 'Setor Exemplo - Unidade Alfa');
    const { child, evidence } = await openSubfolder(page, parent, target, NAV);
    expect(child).toMatchObject({ title: 'Setor Exemplo - Unidade Alfa', total: 3, path: '/Meu Air/Setor Exemplo - Unidade Alfa', breadcrumb: ['Meu Air', 'Setor Exemplo - Unidade Alfa'] });
    expect(evidence).toEqual([
      'URL mudou',
      'título = "Setor Exemplo - Unidade Alfa"',
      'breadcrumb Meu Air / Setor Exemplo - Unidade Alfa ≅ Meu Air / Setor Exemplo - Unidade Alfa',
      'caminho = /Meu Air/Setor Exemplo - Unidade Alfa',
    ]);

    const back = await returnToParent(page, child, parent, NAV);
    expect(back.restored).toMatchObject({ title: 'Meu Air', total: 4, pageUrl: parent.pageUrl });
    expect(back.evidence).toContain('listagem idêntica à lida antes');
    expect(back.evidence[0]).toBe('via link do pai no breadcrumb');
    expect(await navClicks(page)).toEqual([]);
    expect(await forbiddenClicks(page)).toEqual([]);
    await page.context().close();
  });

  it('lê todas as páginas da subpasta (35 itens) e volta ao pai', async () => {
    const page = await open('alfa', { renderDelayMs: 100 });
    const { parent, target } = await subfolder(page, 'registros fulano');
    const { child } = await openSubfolder(page, parent, target, NAV);
    const source = createAirListingSource(page, fingerprintOf(child.environment), {}, NAV);
    const { items, coverage } = await scanListing(source, { maxPages: 5, readTimeoutMs: 5_000 });
    expect(coverage).toMatchObject({ pagesRead: 2, uniqueItems: 35, reportedTotal: 35, complete: true, issues: [] });
    expect(items.every((i) => i.path === '/Meu Air/Setor Exemplo - Unidade Alfa/registros fulano')).toBe(true);
    expect(items.every((i) => i.kind === 'file' && i.kindEvidence === 'icon:img:pdf icon')).toBe(true);

    await returnToParent(page, child, parent, NAV);
    expect(await forbiddenClicks(page)).toEqual([]);
    await page.context().close();
  });

  it('abre subpasta vazia no 3º nível pelo breadcrumb colapsado e volta pelo "voltar" verificado', async () => {
    const page = await open('root');
    const root = await subfolder(page, 'Setor Exemplo - Unidade Alfa');
    await openSubfolder(page, root.parent, root.target, NAV);
    const { parent, target } = await subfolder(page, 'vazia');
    const { child, evidence } = await openSubfolder(page, parent, target, NAV);
    expect(child).toMatchObject({ title: 'vazia', total: 0, breadcrumb: ['Meu Air', '…', 'vazia'] });
    expect(child.path).toBeUndefined();
    expect(evidence).toContain('breadcrumb Meu Air / … / vazia ≅ Meu Air / Setor Exemplo - Unidade Alfa / vazia');

    const back = await returnToParent(page, child, parent, NAV);
    expect(back.evidence[0]).toBe('via voltar do cabeçalho (pai colapsado no breadcrumb)');
    expect(back.restored).toMatchObject({ title: 'Setor Exemplo - Unidade Alfa', total: 3, path: '/Meu Air/Setor Exemplo - Unidade Alfa' });
    expect(await navClicks(page)).toEqual(['back']);
    expect(await forbiddenClicks(page)).toEqual([]);
    await page.context().close();
  });

  it('interrompe quando o "voltar" leva a uma pasta que não é a pai', async () => {
    const page = await open('beta', { backTo: 'other' });
    const { parent, target } = await subfolder(page, 'Sub');
    const { child } = await openSubfolder(page, parent, target, NAV);
    await expect(returnToParent(page, child, parent, { timeoutMs: 1_000, pollMs: 50 })).rejects.toThrow(/Pasta exibida: "Outra"/);
    expect(await forbiddenClicks(page)).toEqual([]);
    await page.context().close();
  });

  it('recusa o retorno automático se a pasta exibida não for mais a subpasta aberta', async () => {
    const page = await open('alfa');
    const { parent, target } = await subfolder(page, 'vazia');
    const { child } = await openSubfolder(page, parent, target, NAV);
    await page.goBack();
    await page.waitForTimeout(100);
    await expect(returnToParent(page, child, parent, NAV)).rejects.toThrow(/não é a subpasta aberta/);
    await page.context().close();
  });

  it('nome de pasta é dado, não rótulo: "Editoriais" pode ser aberta', async () => {
    const page = await open('root');
    const { parent, target } = await subfolder(page, 'Editoriais');
    await expect(openSubfolder(page, parent, target, NAV)).resolves.toMatchObject({ child: { title: 'Editoriais' } });
    await page.context().close();
  });

  it('interrompe quando a pasta aberta não é a escolhida', async () => {
    const page = await open('root', { misrouteTo: { alfa: 'other' } });
    const { parent, target } = await subfolder(page, 'Setor Exemplo - Unidade Alfa');
    await expect(openSubfolder(page, parent, target, { timeoutMs: 1_000, pollMs: 50 })).rejects.toThrow(FolderIdentityError);
    await page.context().close();
  });

  it('recusa abrir linha que não é comprovadamente pasta e não clica nela', async () => {
    const page = await open('root');
    const parent = await readFolderContext(page);
    const fileRow = { name: 'leia-me.pdf', rowIndex: 2, expectedPath: '/Meu Air/leia-me.pdf' };
    await expect(openSubfolder(page, parent, fileRow, NAV)).rejects.toThrow(SafetyViolation);
    expect(await forbiddenClicks(page)).toEqual([]);
    await page.context().close();
  });

  it('recusa quando a linha mudou entre a leitura e o clique', async () => {
    const page = await open('root');
    const parent = await readFolderContext(page);
    await expect(openSubfolder(page, parent, { name: 'Editoriais', rowIndex: 0 }, NAV)).rejects.toThrow(/não é a subpasta escolhida/);
    expect(await forbiddenClicks(page)).toEqual([]);
    await page.context().close();
  });

  it('filtro de tipo diferente de "Todos" ou busca preenchida tornam a leitura parcial', async () => {
    for (const options of [{ typeFilter: 'Pastas' }, { search: 'registros' }]) {
      const page = await open('alfa', options);
      const env = await detectEnvironment(page, {});
      const { coverage } = await scanListing(createAirListingSource(page, fingerprintOf(env), {}, NAV), { maxPages: 5, readTimeoutMs: 5_000 });
      expect(coverage.complete).toBe(false);
      expect(coverage.issues.map((i) => i.kind)).toContain('filter-active');
      await page.context().close();
    }
  });

  it('o ícone ChevronRight do separador do breadcrumb não é tomado por "próxima página"', async () => {
    const page = await open('alfa');
    expect(await probePagination(page)).toEqual({ status: 'found', label: 'icon:chevron-right', disabled: true });
    await page.context().close();
  });

  it('extrai o ícone da coluna de tipo e classifica pasta pelo ícone', async () => {
    const page = await open('root');
    const listing = await extractListing(page);
    expect(listing.rows.map((r) => r.typeIcon)).toEqual(['folder', 'folder', 'img:pdf icon', 'folder']);
    expect(listing.typeFilter).toBe('Todos');
    expect(listing.searchActive).toBe(false);
    const { items } = parseRows(listing.rows, { pageNumber: 1, observedAt: 'x' });
    expect(items.map((i) => [i.kind, i.kindEvidence])).toEqual([
      ['folder', 'icon:folder'],
      ['folder', 'icon:folder'],
      ['file', 'icon:img:pdf icon'],
      ['folder', 'icon:folder'],
    ]);
    await page.context().close();
  });

  it.each<[string, string | null]>([
    ['ícone de tipo ausente (só ícones "file-*" na coluna Status)', null],
    ['<img> com alt fora do padrão "<tipo> icon"', 'avatar'],
  ])('regressão: %s → unknown, nunca deduzido de outras colunas nem da extensão', async (_, fileAlt) => {
    const page = await open('editoriais', { fileAlt });
    const { items } = parseRows((await extractListing(page)).rows, { pageNumber: 1, observedAt: 'x' });
    expect(items.map((i) => i.kind)).toEqual(['unknown', 'unknown']);
    expect(await listVisibleSubfolders(page, await readFolderContext(page))).toEqual([]);
    await page.context().close();
  });
});

/**
 * Investigação POC-01E: no AIR real, um clique de abertura terminou em "tempo esgotado" sem dizer
 * por quê. Cada causa possível precisa deixar uma assinatura própria nas verificações (sem nomes),
 * para ser identificada na próxima execução real em vez de simplesmente aumentar o prazo.
 */
describe('diagnóstico de identidade após o clique', () => {
  const SHORT = { timeoutMs: 800, pollMs: 50 };
  const alfa = 'Setor Exemplo - Unidade Alfa';

  async function attempt(options: Partial<TreeFixtureOptions>, name = alfa) {
    const page = await open('root', options);
    const { parent, target } = await subfolder(page, name);
    const error = await openSubfolder(page, parent, target, SHORT).then(
      () => undefined,
      (e: unknown) => e,
    );
    const forbidden = await forbiddenClicks(page);
    await page.context().close();
    expect(error).toBeInstanceOf(NavigationLostError);
    expect(forbidden).toEqual([]);
    return identityDiagnostic(error)!;
  }

  it('clique sem navegação: URL não muda', async () => {
    const d = await attempt({ inertRows: ['alfa'] });
    expect(d).toMatchObject({ code: 'timeout', checks: { conditions: { urlChanged: false, titleMatches: false }, readFailures: {} } });
  });

  it('carregamento lento: URL mudou, título ainda é o do pai', async () => {
    const d = await attempt({ slowOpen: { alfa: 3_000 } });
    expect(d).toMatchObject({ code: 'timeout', checks: { conditions: { urlChanged: true, titleMatches: false } } });
  });

  it('título exibido diferente do nome da linha: título e breadcrumb divergem em toda leitura', async () => {
    const d = await attempt({ titleOverride: { alfa: alfa.toUpperCase() } });
    expect(d.code).toBe('timeout');
    expect(d.checks?.readFailures['heading-breadcrumb-mismatch']).toBeGreaterThan(0);
    expect(d.checks?.conditions?.titleMatches).not.toBe(true);
  });

  it('breadcrumb que trunca o nome no texto: mesma assinatura de título x breadcrumb', async () => {
    const d = await attempt({ breadcrumbTruncateAt: 10 });
    expect(d.checks?.readFailures['heading-breadcrumb-mismatch']).toBeGreaterThan(0);
  });

  it('"Caminho" uniforme mas diferente do esperado: abre, e a verificação final recusa', async () => {
    const root: TreeNode = { id: 'root', name: 'Meu Air', type: 'folder', children: [
      { id: 'x', name: 'X', type: 'folder', children: [{ id: 'x1', name: 'a.pdf', type: 'file', pathOverride: '/Outro' }, { id: 'x2', name: 'b.pdf', type: 'file', pathOverride: '/Outro' }] },
    ] };
    const d = await attempt({ root }, 'X');
    expect(d).toEqual({ category: 'identity-mismatch', code: 'path-mismatch' });
  });

  it('"Caminho" divergente entre linhas, nenhuma igual ao esperado: leitura recusada até o prazo', async () => {
    const root: TreeNode = { id: 'root', name: 'Meu Air', type: 'folder', children: [
      { id: 'x', name: 'X', type: 'folder', children: [{ id: 'x1', name: 'a.pdf', type: 'file', pathOverride: '/Outro1' }, { id: 'x2', name: 'b.pdf', type: 'file', pathOverride: '/Outro2' }] },
    ] };
    const d = await attempt({ root }, 'X');
    expect(d.code).toBe('timeout');
    expect(d.checks?.readFailures['path-divergent']).toBeGreaterThan(0);
  });

  it('pasta errada (outro destino): URL muda, título não confere', async () => {
    const d = await attempt({ misrouteTo: { alfa: 'other' } });
    expect(d).toMatchObject({ code: 'timeout', checks: { conditions: { urlChanged: true, titleMatches: false } } });
  });

  it('a assinatura diagnóstica não contém nomes, caminhos nem URLs', async () => {
    const d = await attempt({ titleOverride: { alfa: alfa.toUpperCase() } });
    const text = JSON.stringify(d);
    for (const s of ['Setor', 'Alfa', 'Meu Air', 'fixture.test', 'my-air', '/']) expect(text).not.toContain(s);
  });
});

describe('ADR-013: identidade x conteúdo na volta ao pai', () => {
  type Cfg = { root: TreeNode };
  const mutate = (page: Page, fn: string) => page.evaluate((code) => new Function('cfg', code)((window as unknown as { __cfg: Cfg }).__cfg), fn);

  async function roundTrip(change: string) {
    const page = await open('root');
    const { parent, target } = await subfolder(page, 'Setor Exemplo - Unidade Alfa');
    const { child } = await openSubfolder(page, parent, target, NAV);
    await mutate(page, change); // alteração no AIR enquanto estamos na subpasta
    const outcome = await returnToParent(page, child, parent, NAV).then((o) => o, (e: unknown) => e);
    const forbidden = await forbiddenClicks(page);
    await page.context().close();
    expect(forbidden).toEqual([]);
    return outcome;
  }

  it('identidade confirmada e total alterado: aceita a volta e registra content-changed', async () => {
    const outcome = await roundTrip("cfg.root.children = cfg.root.children.filter((c) => c.id !== 'other');");
    expect(outcome).toMatchObject({ restored: { title: 'Meu Air', total: 3 }, contentChanged: { total: true, listing: true } });
  });

  it('identidade confirmada e listagem alterada com o mesmo total: content-changed só de listagem', async () => {
    const outcome = await roundTrip("cfg.root.children.find((c) => c.id === 'leia').name = 'leia-me-v2.pdf';");
    expect(outcome).toMatchObject({ contentChanged: { total: false, listing: true } });
  });

  it('sem alteração: volta sem content-changed', async () => {
    const outcome = await roundTrip('');
    expect(outcome).not.toHaveProperty('contentChanged');
  });

  it('identidade divergente ("Caminho" de outra pasta): falha fechada como identity-mismatch, sem valores', async () => {
    const error = await roundTrip("for (const c of cfg.root.children) c.pathOverride = '/Outra Raiz';");
    expect(error).toBeInstanceOf(FolderIdentityError);
    const d = identityDiagnostic(error)!;
    expect(d).toMatchObject({ category: 'identity-mismatch', code: 'identity-mismatch', checks: { conditions: { url: true, title: true, breadcrumb: true, path: false } } });
    for (const s of ['Meu Air', 'Outra Raiz', 'fixture.test', '/']) expect(JSON.stringify(d)).not.toContain(s);
  });

  it('pasta pai esvaziada: sem Caminho não há divergência de identidade, só de conteúdo', async () => {
    const outcome = await roundTrip('cfg.root.children = [];');
    expect(outcome).toMatchObject({ restored: { total: 0 }, contentChanged: { total: true } });
  });
});
