import type { Locator, Page } from 'playwright';
import { pageSignature } from '../core/scanner.js';
import { classifyRow } from '../core/records.js';
import { OpenRefusedError, SafetyViolation, assertFolderOpenTarget, assertParentLinkTarget } from '../safety/scope-validator.js';
import type { AirEnvironment } from '../types/inventory.js';
import { BREADCRUMB_COLLAPSED, detectEnvironment } from './navigator.js';
import { extractListing } from './reader.js';

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
  /** Assinatura da página exibida no momento da leitura. */
  signature: string;
  environment: AirEnvironment;
};

export class FolderIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FolderIdentityError';
  }
}

/**
 * Falha DEPOIS de um clique de navegação (abrir ou voltar): a pasta exibida é incerta.
 * Quem navega deve parar tudo e preservar o diagnóstico, sem novos cliques.
 */
export class NavigationLostError extends FolderIdentityError {
  constructor(message: string) {
    super(message);
    this.name = 'NavigationLostError';
  }
}

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
  if (environment.pageUrl.status !== 'identified') throw new FolderIdentityError(`URL não identificada: ${environment.pageUrl.reason}`);
  if (listing.folderTitle === undefined || listing.reportedTotal === undefined) {
    throw new FolderIdentityError('Título "Nome (N)" da pasta não encontrado ou ambíguo.');
  }
  if (environment.currentFolder.status !== 'identified' || environment.currentFolder.value !== listing.folderTitle) {
    throw new FolderIdentityError('Pasta atual não confirmada: título e breadcrumb divergem ou estão ausentes.');
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
      throw new FolderIdentityError('Coluna "Caminho" com valores diferentes entre linhas da mesma pasta.');
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
 * Espera até a pasta exibida satisfazer `accept` e ficar estável (duas leituras iguais).
 * Um diálogo aberto interrompe imediatamente: o clique não foi uma navegação.
 */
async function waitForFolder(
  page: Page,
  accept: (ctx: FolderContext) => boolean,
  options: FolderNavigationOptions,
  what: string,
  expectedPath?: string,
): Promise<FolderContext> {
  const deadline = Date.now() + options.timeoutMs;
  let last: FolderContext | undefined;
  let seen: FolderContext | undefined;
  while (Date.now() < deadline) {
    await page.waitForTimeout(options.pollMs);
    if (await dialogOpen(page)) throw new SafetyViolation(`Um diálogo foi aberto ao ${what}; operação interrompida. Feche-o manualmente.`);
    let ctx: FolderContext;
    try {
      ctx = await readFolderContext(page, expectedPath);
    } catch {
      last = undefined; // carregando ou em transição
      continue;
    }
    seen = ctx;
    if (accept(ctx) && last && last.signature === ctx.signature && last.pageUrl === ctx.pageUrl && last.total === ctx.total) return ctx;
    last = accept(ctx) ? ctx : undefined;
  }
  const shown = seen ? ` Pasta exibida: "${seen.title}" (${seen.pageUrl}).` : '';
  throw new FolderIdentityError(`Tempo esgotado ao ${what}: a pasta esperada não foi confirmada.${shown}`);
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
  if (child.pageUrl === parent.pageUrl) throw new FolderIdentityError('A URL não mudou após abrir a subpasta.');
  evidence.push('URL mudou');
  if (child.title !== target.name) throw new FolderIdentityError(`Título "${child.title}" difere da subpasta escolhida "${target.name}".`);
  evidence.push(`título = "${target.name}"`);
  const parentChain = chainOf(parent);
  if (parentChain.length === 0) throw new FolderIdentityError('Caminho completo da pasta pai desconhecido; identidade não confirmável.');
  const expectedCrumbs = [...parentChain, target.name];
  if (child.breadcrumb !== undefined) {
    if (!breadcrumbMatches(child.breadcrumb, expectedCrumbs)) {
      throw new FolderIdentityError(`Breadcrumb "${child.breadcrumb.join(' / ')}" não corresponde a "${expectedCrumbs.join(' / ')}".`);
    }
    evidence.push(`breadcrumb ${child.breadcrumb.join(' / ')} ≅ ${expectedCrumbs.join(' / ')}`);
  }
  if (child.path !== undefined && target.expectedPath !== undefined) {
    if (child.path !== target.expectedPath) throw new FolderIdentityError(`Caminho "${child.path}" difere do esperado "${target.expectedPath}".`);
    evidence.push(`caminho = ${target.expectedPath}`);
  }
  // Título sozinho não basta (nomes podem se repetir em pastas diferentes).
  if (evidence.length < 3) throw new FolderIdentityError('Sem breadcrumb nem caminho para confirmar a identidade da subpasta.');
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
    const child = await waitForFolder(page, (ctx) => ctx.pageUrl !== parent.pageUrl && ctx.title === target.name, options, 'abrir a subpasta', target.expectedPath);
    return { child, evidence: verifyChildIdentity(parent, target, child) };
  } catch (error) {
    throw new NavigationLostError(error instanceof Error ? error.message : String(error));
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
): Promise<{ restored: FolderContext; evidence: string[] }> {
  const here = await readFolderContext(page, child.path);
  if (here.pageUrl !== child.pageUrl || here.title !== child.title) {
    throw new FolderIdentityError('A pasta exibida não é a subpasta aberta; retorno automático recusado.');
  }
  const nav = page.locator('nav[aria-label*="breadcrumb" i]');
  if ((await nav.count()) !== 1) throw new FolderIdentityError('Breadcrumb ausente ou ambíguo; retorne manualmente.');
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
      throw new FolderIdentityError('Pai colapsado no breadcrumb e "voltar" do cabeçalho não identificado com segurança; retorne manualmente.');
    }
    await back.click();
    via = 'voltar do cabeçalho (pai colapsado no breadcrumb)';
  }

  // A URL da SPA muda antes do conteúdo: espera URL E título do pai; o restante é verificado abaixo.
  const restored = await waitForFolder(page, (ctx) => ctx.pageUrl === parent.pageUrl && ctx.title === parent.title, options, 'voltar à pasta pai', parent.path);
  const mismatch = [
    restored.pageUrl !== parent.pageUrl && 'URL',
    restored.title !== parent.title && 'título',
    restored.total !== parent.total && 'total',
    restored.path !== parent.path && 'caminho',
    (restored.breadcrumb ?? []).join('/') !== (parent.breadcrumb ?? []).join('/') && 'breadcrumb',
  ].filter(Boolean);
  if (mismatch.length > 0) {
    throw new FolderIdentityError(`Após voltar, a pasta exibida ("${restored.title}") não é a pasta pai: ${mismatch.join(', ')} diferem.`);
  }
  const evidence = [`via ${via}`, `URL = ${parent.pageUrl}`, `título = "${parent.title}"`, `total = ${parent.total}`];
  if (parent.path) evidence.push(`caminho = ${parent.path}`);
  evidence.push(restored.signature === parent.signature ? 'listagem idêntica à lida antes' : 'listagem exibida difere da lida antes (outra página?)');
  return { restored, evidence };
}
