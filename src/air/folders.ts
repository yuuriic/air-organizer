import type { Locator, Page } from 'playwright';
import { activePageOf, pageSignature } from '../core/scanner.js';
import { classifyRow } from '../core/records.js';
import { OpenRefusedError, SafetyViolation, assertFolderOpenTarget, assertParentLinkTarget } from '../safety/scope-validator.js';
import type { AirEnvironment } from '../types/inventory.js';
import { BREADCRUMB_COLLAPSED, detectEnvironment, goToPageNumber } from './navigator.js';
import { ListingNotFoundError, extractListing } from './reader.js';

/**
 * Navegação controlada entre uma pasta e UMA subpasta (POC-01C). Sem recursão.
 *
 * Mecanismos observados no AIR real (somente leitura do código dos handlers):
 * - clique na linha de PASTA: navega para a subpasta (navegação da SPA);
 * - clique na linha de ARQUIVO: abre um visualizador editável — nunca é clicado;
 * - breadcrumb: itens ancestrais são links que navegam para a pasta pelo ID; o item
 *   atual tem aria-current="page". Só existe fora da raiz.
 */

/** Identidade observada de uma pasta exibida. */
export type FolderContext = {
  pageUrl: string;
  /** Título sem o total: "<h2>Unidade Alfa (2)</h2>" → "Unidade Alfa". */
  title: string;
  /** Total da pasta exibido no título. */
  total: number;
  /** Segmentos do breadcrumb; ausente na raiz. */
  breadcrumb?: string[];
  /** Caminho completo confirmado da pasta, lido da coluna "Caminho"; ausente se vazia. */
  path?: string;
  /**
   * Linhas da página exibida cujo "Caminho" difere do caminho da pasta. Observado no AIR real:
   * item listado numa pasta com localização registrada em outro ramo (não é atalho).
   */
  pathAnomalies?: number;
  /** Página ativa no paginador no momento da leitura (undefined = sem paginador). */
  activePage?: number;
  /** Linhas exibidas na página lida. */
  rows: number;
  /** Assinatura da página exibida no momento da leitura. */
  signature: string;
  environment: AirEnvironment;
};

/**
 * Qual verificação de identidade falhou. Código seguro para logs (sem nomes, caminhos nem URLs);
 * a mensagem do erro pode conter esses dados e só sai no modo detalhado.
 */
export type IdentityFailure =
  | 'url-not-identified'
  | 'title-missing'
  | 'heading-breadcrumb-mismatch'
  | 'path-divergent'
  | 'listing-not-found'
  | 'url-unchanged'
  | 'title-mismatch'
  | 'parent-chain-unknown'
  | 'breadcrumb-mismatch'
  | 'path-mismatch'
  | 'insufficient-evidence'
  | 'not-the-opened-folder'
  | 'breadcrumb-missing'
  | 'back-control-ambiguous'
  | 'identity-mismatch'
  /** Antes de voltar, a subpasta não pôde ser reposicionada na página em que foi aberta. */
  | 'child-reposition-failed'
  /** Depois de voltar, o pai não está na página ativa em que foi lido. */
  | 'page-mismatch'
  /** Depois de voltar, o total do pai indica itens, mas a listagem exibida está vazia. */
  | 'empty-listing'
  | 'timeout'
  | 'read-error';

/**
 * Verificações observadas até o prazo de uma espera (sem valores). `conditions`: resultado de
 * cada condição na última leitura bem-sucedida; `readFailures`: leituras que falharam, por código.
 */
export type IdentityChecks = {
  observations: number;
  conditions?: Record<string, boolean>;
  readFailures: Partial<Record<IdentityFailure, number>>;
  /** Todas as condições satisfeitas, mas a pasta não ficou estável por duas leituras. */
  unstable: number;
};

export class FolderIdentityError extends Error {
  constructor(
    message: string,
    readonly code: IdentityFailure = 'read-error',
    readonly checks?: IdentityChecks,
  ) {
    super(message);
    this.name = 'FolderIdentityError';
  }

  get category(): NavigationFailureCategory {
    return IDENTITY_CODES.has(this.code) ? 'identity-mismatch' : 'navigation-failed';
  }
}

/**
 * Falha DEPOIS de um clique de navegação (abrir ou voltar): a pasta exibida é incerta.
 * Quem navega deve parar tudo e preservar o diagnóstico, sem novos cliques.
 */
export class NavigationLostError extends FolderIdentityError {
  constructor(message: string, cause?: unknown) {
    super(message, cause instanceof FolderIdentityError ? cause.code : 'read-error', cause instanceof FolderIdentityError ? cause.checks : undefined);
    this.name = 'NavigationLostError';
  }
}

/** Código e verificações de um erro de navegação, sem dados identificáveis. */
export function identityDiagnostic(error: unknown): { category: NavigationFailureCategory; code: IdentityFailure; checks?: IdentityChecks } | undefined {
  return error instanceof FolderIdentityError ? { category: error.category, code: error.code, ...(error.checks ? { checks: error.checks } : {}) } : undefined;
}

/**
 * Categoria do diagnóstico (ADR-013): 'identity-mismatch' = a pasta foi lida e NÃO é a esperada;
 * 'navigation-failed' = não foi possível confirmar onde se está (prazo, controle ausente, leitura).
 * Divergência de conteúdo ('content-changed') não é erro: é registrada como pendência.
 */
export type NavigationFailureCategory = 'identity-mismatch' | 'navigation-failed';
const IDENTITY_CODES: ReadonlySet<IdentityFailure> = new Set<IdentityFailure>(['identity-mismatch', 'url-unchanged', 'title-mismatch', 'breadcrumb-mismatch', 'path-mismatch', 'not-the-opened-folder']);

/** Resultado de uma volta verificada. `contentChanged`: identidade confirmada, conteúdo divergente. */
export type ReturnOutcome = { restored: FolderContext; evidence: string[]; contentChanged?: { total: boolean; listing: boolean } };

export type SubfolderCandidate = { name: string; rowIndex: number; expectedPath?: string };

export type FolderNavigationOptions = { timeoutMs: number; pollMs: number };

const PATH_COLUMN = /^caminho$/i;

function uniformPath(rows: ReadonlyArray<{ cells: Record<string, string> }>): string | undefined | null {
  const paths = new Set(rows.map((r) => Object.entries(r.cells).find(([h]) => PATH_COLUMN.test(h))?.[1]?.trim() ?? ''));
  if (paths.size === 0) return undefined;
  if (paths.size > 1 || paths.has('')) return null; // inconsistente
  return [...paths][0];
}

/**
 * Lê a identidade da pasta exibida. Sem título "Nome (N)" ou URL, falha fechada.
 * "Caminho" divergente entre linhas só é aceito com um caminho esperado — `expectedPath`
 * (conhecido pelo pai) ou a cadeia do breadcrumb não colapsado — e ao menos uma linha
 * igual a ele; as demais são contadas em `pathAnomalies`. Sem isso, exige unanimidade.
 */
export async function readFolderContext(page: Page, expectedPath?: string): Promise<FolderContext> {
  const [environment, listing] = [await detectEnvironment(page, {}), await extractListing(page)];
  if (environment.pageUrl.status !== 'identified') throw new FolderIdentityError(`URL não identificada: ${environment.pageUrl.reason}`, 'url-not-identified');
  if (listing.folderTitle === undefined || listing.reportedTotal === undefined) {
    throw new FolderIdentityError('Título "Nome (N)" da pasta não encontrado ou ambíguo.', 'title-missing');
  }
  if (environment.currentFolder.status !== 'identified' || environment.currentFolder.value !== listing.folderTitle) {
    throw new FolderIdentityError('Pasta atual não confirmada: título e breadcrumb divergem ou estão ausentes.', 'heading-breadcrumb-mismatch');
  }
  let path = uniformPath(listing.rows);
  let pathAnomalies = 0;
  if (path === null) {
    const paths = listing.rows.map((r) => Object.entries(r.cells).find(([h]) => PATH_COLUMN.test(h))?.[1]?.trim() ?? '');
    // Sem caminho do pai: a cadeia completa só é conhecida pelo breadcrumb NÃO colapsado
    // (2º nível) ou, na raiz (sem breadcrumb), pelo próprio título.
    const crumbs = environment.breadcrumb.status === 'identified' ? environment.breadcrumb.value : undefined;
    expectedPath ??= crumbs ? (crumbs.includes(BREADCRUMB_COLLAPSED) ? undefined : `/${crumbs.join('/')}`) : `/${listing.folderTitle}`;
    if (expectedPath === undefined || !paths.includes(expectedPath)) {
      throw new FolderIdentityError('Coluna "Caminho" com valores diferentes entre linhas da mesma pasta.', 'path-divergent');
    }
    path = expectedPath;
    pathAnomalies = paths.filter((p) => p !== expectedPath).length;
  }
  return {
    pageUrl: environment.pageUrl.value,
    title: listing.folderTitle,
    total: listing.reportedTotal,
    ...(environment.breadcrumb.status === 'identified' ? { breadcrumb: environment.breadcrumb.value } : {}),
    ...(path ? { path } : {}),
    ...(pathAnomalies ? { pathAnomalies } : {}),
    ...(activePageOf(listing.pageIndicator) !== undefined ? { activePage: activePageOf(listing.pageIndicator) } : {}),
    rows: listing.rows.length,
    signature: pageSignature(listing),
    environment,
  };
}

/** Subpastas visíveis na página atual. Só linhas classificadas como pasta pelo ícone. */
export async function listVisibleSubfolders(page: Page, parent: FolderContext): Promise<SubfolderCandidate[]> {
  const listing = await extractListing(page);
  return listing.rows.flatMap((row, rowIndex) => {
    if (classifyRow(row).kind !== 'folder') return [];
    const name = (Object.entries(row.cells).find(([h]) => /^nome$/i.test(h))?.[1] ?? '').trim();
    if (!name) return [];
    return [{ name, rowIndex, ...(parent.path ? { expectedPath: `${parent.path}/${name}` } : {}) }];
  });
}

function listingTable(page: Page): Locator {
  return page.locator('table').filter({ has: page.locator('thead th', { hasText: /^\s*nome\s*$/i }) });
}

async function dialogOpen(page: Page): Promise<boolean> {
  return (await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').count()) > 0;
}

/**
 * Espera até a pasta exibida satisfazer TODAS as `conditions` e ficar estável (duas leituras
 * iguais). Um diálogo aberto interrompe imediatamente: o clique não foi uma navegação.
 * No tempo esgotado, o erro traz `checks`: qual condição falhou na última leitura e quais
 * leituras falharam (por código) — para diagnosticar sem expor nomes, e sem só aumentar o prazo.
 */
async function waitForFolder(
  page: Page,
  conditions: Record<string, (ctx: FolderContext) => boolean>,
  options: FolderNavigationOptions,
  what: string,
  expectedPath?: string,
): Promise<FolderContext> {
  const deadline = Date.now() + options.timeoutMs;
  const checks: IdentityChecks = { observations: 0, readFailures: {}, unstable: 0 };
  let last: FolderContext | undefined;
  let seen: FolderContext | undefined;
  while (Date.now() < deadline) {
    await page.waitForTimeout(options.pollMs);
    if (await dialogOpen(page)) throw new SafetyViolation(`Um diálogo foi aberto ao ${what}; operação interrompida. Feche-o manualmente.`);
    checks.observations++;
    let ctx: FolderContext;
    try {
      ctx = await readFolderContext(page, expectedPath);
    } catch (error) {
      // Carregando, em transição — ou uma condição de leitura que nunca será satisfeita.
      const code = error instanceof FolderIdentityError ? error.code : error instanceof ListingNotFoundError ? 'listing-not-found' : 'read-error';
      checks.readFailures[code] = (checks.readFailures[code] ?? 0) + 1;
      last = undefined;
      continue;
    }
    seen = ctx;
    checks.conditions = Object.fromEntries(Object.entries(conditions).map(([k, test]) => [k, test(ctx)]));
    const accepted = Object.values(checks.conditions).every(Boolean);
    if (accepted && last && last.signature === ctx.signature && last.pageUrl === ctx.pageUrl && last.total === ctx.total) return ctx;
    if (accepted && last) checks.unstable++;
    last = accepted ? ctx : undefined;
  }
  const shown = seen ? ` Pasta exibida: "${seen.title}" (${seen.pageUrl}).` : '';
  throw new FolderIdentityError(`Tempo esgotado ao ${what}: a pasta esperada não foi confirmada.${shown}`, 'timeout', checks);
}

function sameSegments(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((s, i) => s === b[i]);
}

/**
 * Compara o breadcrumb exibido com a cadeia completa esperada. Um único marcador de
 * colapso ("…", menu "More" do AIR) corresponde a um ou mais ancestrais ocultos.
 */
export function breadcrumbMatches(observed: readonly string[], expected: readonly string[]): boolean {
  const k = observed.indexOf(BREADCRUMB_COLLAPSED);
  if (k < 0) return sameSegments(observed, expected);
  if (observed.indexOf(BREADCRUMB_COLLAPSED, k + 1) >= 0) return false;
  const head = observed.slice(0, k);
  const tail = observed.slice(k + 1);
  const hidden = expected.length - head.length - tail.length;
  return hidden >= 1 && sameSegments(head, expected.slice(0, k)) && sameSegments(tail, expected.slice(expected.length - tail.length));
}

/** Cadeia completa da pasta: do "Caminho" (sempre exibido no pai, que contém a linha clicada). */
function chainOf(folder: FolderContext): string[] {
  if (folder.path) return folder.path.split('/').filter(Boolean);
  if (folder.breadcrumb && !folder.breadcrumb.includes(BREADCRUMB_COLLAPSED)) return folder.breadcrumb;
  return folder.breadcrumb ? [] : [folder.title]; // sem caminho e com breadcrumb colapsado: desconhecida
}

/** Verifica que `child` é exatamente a subpasta `target` de `parent`. Retorna as evidências. */
export function verifyChildIdentity(parent: FolderContext, target: SubfolderCandidate, child: FolderContext): string[] {
  const evidence: string[] = [];
  if (child.pageUrl === parent.pageUrl) throw new FolderIdentityError('A URL não mudou após abrir a subpasta.', 'url-unchanged');
  evidence.push('URL mudou');
  if (child.title !== target.name) throw new FolderIdentityError(`Título "${child.title}" difere da subpasta escolhida "${target.name}".`, 'title-mismatch');
  evidence.push(`título = "${target.name}"`);
  const parentChain = chainOf(parent);
  if (parentChain.length === 0) throw new FolderIdentityError('Caminho completo da pasta pai desconhecido; identidade não confirmável.', 'parent-chain-unknown');
  const expectedCrumbs = [...parentChain, target.name];
  if (child.breadcrumb !== undefined) {
    if (!breadcrumbMatches(child.breadcrumb, expectedCrumbs)) {
      throw new FolderIdentityError(`Breadcrumb "${child.breadcrumb.join(' / ')}" não corresponde a "${expectedCrumbs.join(' / ')}".`, 'breadcrumb-mismatch');
    }
    evidence.push(`breadcrumb ${child.breadcrumb.join(' / ')} ≅ ${expectedCrumbs.join(' / ')}`);
  }
  if (child.path !== undefined && target.expectedPath !== undefined) {
    if (child.path !== target.expectedPath) throw new FolderIdentityError(`Caminho "${child.path}" difere do esperado "${target.expectedPath}".`, 'path-mismatch');
    evidence.push(`caminho = ${target.expectedPath}`);
  }
  // Título sozinho não basta (nomes podem se repetir em pastas diferentes).
  if (evidence.length < 3) throw new FolderIdentityError('Sem breadcrumb nem caminho para confirmar a identidade da subpasta.', 'insufficient-evidence');
  return evidence;
}

/**
 * Abre UMA subpasta visível pela interface (clique na célula do nome) e confirma a identidade.
 * Pré-condições verificadas imediatamente antes do clique; qualquer dúvida interrompe.
 */
export async function openSubfolder(
  page: Page,
  parent: FolderContext,
  target: SubfolderCandidate,
  options: FolderNavigationOptions,
): Promise<{ child: FolderContext; evidence: string[] }> {
  // Antes do clique: qualquer dúvida vira OpenRefusedError (a pasta exibida não mudou).
  const current = await readFolderContext(page, parent.path).catch((error: unknown) => {
    throw new OpenRefusedError('precondition', error instanceof Error ? error.message : String(error));
  });
  if (current.pageUrl !== parent.pageUrl || current.title !== parent.title) {
    throw new OpenRefusedError('precondition', 'A pasta exibida não é mais a pasta lida; operação interrompida.');
  }
  const listing = await extractListing(page);
  const row = listing.rows[target.rowIndex];
  const nameColumn = listing.headers.findIndex((h) => /^nome$/i.test(h));
  const names = listing.rows.map((r) => (r.cells[listing.headers[nameColumn] ?? ''] ?? '').trim());
  if (!row || nameColumn < 0) throw new OpenRefusedError('row-changed', 'Linha da subpasta não encontrada.');

  const cell = listingTable(page).locator('tbody > tr').nth(target.rowIndex).locator('> td').nth(nameColumn);
  assertFolderOpenTarget({
    expectedName: target.name,
    rowName: names[target.rowIndex] ?? '',
    cellText: ((await cell.textContent()) ?? '').replace(/\s+/g, ' ').trim(),
    kind: classifyRow(row).kind,
    sameNameRows: names.filter((n) => n === target.name).length,
    interactiveInCell: await cell.locator('button, a, input, select, textarea, [role="checkbox"], [role="button"], [role="menuitem"]').count(),
  });

  await cell.click();
  try {
    const child = await waitForFolder(
      page,
      { urlChanged: (ctx) => ctx.pageUrl !== parent.pageUrl, titleMatches: (ctx) => ctx.title === target.name },
      options,
      'abrir a subpasta',
      target.expectedPath,
    );
    return { child, evidence: verifyChildIdentity(parent, target, child) };
  } catch (error) {
    throw new NavigationLostError(error instanceof Error ? error.message : String(error), error);
  }
}

/**
 * Volta à pasta pai e confirma que URL, título, total, caminho e breadcrumb são os
 * observados antes de sair (nenhuma URL é montada).
 * - Preferência: link do pai no breadcrumb (navega pelo ID da pasta).
 * - Se o pai estiver colapsado no menu "More" (3º nível em diante), o menu NÃO é aberto:
 *   usa-se o "voltar" do cabeçalho (seta ao lado do título, histórico da SPA), e o destino
 *   é verificado com rigor — se não for o pai, a operação é interrompida.
 */
export async function returnToParent(
  page: Page,
  child: FolderContext,
  parent: FolderContext,
  options: FolderNavigationOptions,
): Promise<ReturnOutcome> {
  const here = await readFolderContext(page, child.path);
  if (here.pageUrl !== child.pageUrl || here.title !== child.title) {
    throw new FolderIdentityError('A pasta exibida não é a subpasta aberta; retorno automático recusado.', 'not-the-opened-folder');
  }
  // O AIR mantém a página corrente ao voltar (observado na POC-01E): sair da subpasta na página 2
  // exibe o pai numa "página 2". Antes de voltar, a subpasta volta à página em que foi aberta,
  // com a página ativa e a listagem conferidas contra o registrado na abertura.
  if (child.activePage !== undefined && here.activePage !== child.activePage) {
    const jump = await goToPageNumber(page, child.activePage, child.signature, options);
    if (jump.status !== 'reached') {
      throw new FolderIdentityError(`Não foi possível reposicionar a subpasta na página ${child.activePage} antes de voltar: ${jump.reason}`, 'child-reposition-failed');
    }
  }
  const nav = page.locator('nav[aria-label*="breadcrumb" i]');
  if ((await nav.count()) !== 1) throw new FolderIdentityError('Breadcrumb ausente ou ambíguo; retorne manualmente.', 'breadcrumb-missing');
  const items = nav.locator('li:not([role="presentation"])');
  const count = await items.count();
  const currentItem = items.nth(count - 1);
  const parentItem = items.nth(count - 2);
  const parentLinks = parentItem.locator('a');
  const parentText = count >= 2 ? ((await parentItem.textContent()) ?? '').trim() : '';
  const direct = count >= 2 && (await parentLinks.count()) === 1 && parentText === parent.title;

  let via: string;
  if (direct) {
    assertParentLinkTarget({
      expectedParent: parent.title,
      expectedCurrent: child.title,
      currentText: ((await currentItem.textContent()) ?? '').trim(),
      currentIsCurrentPage: (await currentItem.locator('[aria-current="page"]').count()) === 1,
      linkCount: 1,
      linkText: parentText,
    });
    await parentLinks.first().click();
    via = 'link do pai no breadcrumb';
  } else {
    // Seta de voltar: única no cabeçalho que contém o título "<pasta> (N)" da subpasta.
    const header = page.locator('div:has(> svg.lucide-arrow-left)').filter({ has: page.locator('h2', { hasText: `${child.title} (${child.total})` }) });
    const back = header.locator('> svg.lucide-arrow-left');
    if ((await header.count()) !== 1 || (await back.count()) !== 1 || (await page.locator('svg.lucide-arrow-left').count()) !== 1) {
      throw new FolderIdentityError('Pai colapsado no breadcrumb e "voltar" do cabeçalho não identificado com segurança; retorne manualmente.', 'back-control-ambiguous');
    }
    await back.click();
    via = 'voltar do cabeçalho (pai colapsado no breadcrumb)';
  }

  // A URL da SPA muda antes do conteúdo: espera URL E título do pai; o restante é verificado abaixo.
  const restored = await waitForFolder(
    page,
    { urlIsParent: (ctx) => ctx.pageUrl === parent.pageUrl, titleIsParent: (ctx) => ctx.title === parent.title },
    options,
    'voltar à pasta pai',
    parent.path,
  );
  // ADR-013: IDENTIDADE primeiro (é a mesma pasta?), CONTEÚDO depois (ela mudou?).
  // Identidade: URL e título sempre; breadcrumb quando exibido; "Caminho" só quando os dois lados o
  // exibem (vem das linhas: uma pasta esvaziada não tem "Caminho", e isso é conteúdo, não identidade).
  const identity = {
    url: restored.pageUrl === parent.pageUrl,
    title: restored.title === parent.title,
    breadcrumb: (restored.breadcrumb ?? []).join('/') === (parent.breadcrumb ?? []).join('/'),
    path: restored.path === undefined || parent.path === undefined || restored.path === parent.path,
  };
  const labels: Record<keyof typeof identity, string> = { url: 'URL', title: 'título', breadcrumb: 'breadcrumb', path: 'caminho' };
  const mismatch = (Object.keys(identity) as Array<keyof typeof identity>).filter((k) => !identity[k]).map((k) => labels[k]);
  if (mismatch.length > 0) {
    // Falha fechada: não é comprovadamente a pasta pai.
    throw new FolderIdentityError(`Após voltar, a pasta exibida ("${restored.title}") não é a pasta pai: ${mismatch.join(', ')} diferem.`, 'identity-mismatch', {
      observations: 1,
      conditions: identity,
      readFailures: {},
      unstable: 0,
    });
  }
  // Estado do pai (POC-01E): o pai precisa estar na página em que foi lido e exibir linhas quando o
  // total indica itens. Uma listagem incomparável nunca é aceita como volta válida — sem isso, os
  // cliques seguintes partiriam de uma página que não é a registrada.
  const view = { activePage: restored.activePage === parent.activePage, rowsPresent: restored.total === 0 || restored.rows > 0 };
  if (!view.activePage || !view.rowsPresent) {
    const code: IdentityFailure = !view.rowsPresent ? 'empty-listing' : 'page-mismatch';
    throw new FolderIdentityError(
      `Após voltar, o pai não está na página esperada (ativa: ${restored.activePage ?? 'nenhuma'}; esperada: ${parent.activePage ?? 'nenhuma'}; linhas: ${restored.rows}; total: ${restored.total}).`,
      code,
      { observations: 1, conditions: view, readFailures: {}, unstable: 0 },
    );
  }
  // Conteúdo (mesma página ativa, portanto comparável): total e listagem.
  const totalChanged = restored.total !== parent.total;
  const listingChanged = restored.signature !== parent.signature;
  const evidence = [`via ${via}`, `URL = ${parent.pageUrl}`, `título = "${parent.title}"`];
  if (parent.path) evidence.push(`caminho = ${parent.path}`);
  evidence.push(`página ativa = ${parent.activePage ?? 'sem paginador'}`);
  evidence.push(totalChanged ? `total mudou de ${parent.total} para ${restored.total}` : `total = ${parent.total}`);
  evidence.push(listingChanged ? 'listagem difere da lida antes' : 'listagem idêntica à lida antes');
  return {
    restored,
    evidence,
    // Divergência OBSERVADA; a causa (alteração concorrente ou outra) não é afirmada.
    ...(totalChanged || listingChanged ? { contentChanged: { total: totalChanged, listing: listingChanged } } : {}),
  };
}
