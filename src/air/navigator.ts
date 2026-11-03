import type { Locator, Page } from 'playwright';
import { pageSignature, type ListingSource, type NextPageResult } from '../core/scanner.js';
import {
  NEXT_PAGE_ICON_LABEL,
  NEXT_PAGE_LABEL,
  SafetyViolation,
  assertReadOnlyAction,
  compareScope,
  fingerprintOf,
  sanitizeUrl,
  type ScopeFingerprint,
} from '../safety/scope-validator.js';
import type { AirEnvironment, Identified } from '../types/inventory.js';
import { extractListing } from './reader.js';

/** Valores confirmados pelo implantador. A UI ainda não tem seletor validado para eles. */
export type OperatorContext = { client?: string; sector?: string };

const BREADCRUMB_SCRIPT = String.raw`(() => {
  const text = (el) => (el ? (el.innerText ?? el.textContent ?? '') : '').replace(/\s+/g, ' ').trim();
  const nav = document.querySelector('nav[aria-label*="breadcrumb" i], [aria-label*="breadcrumb" i], ol[class*="breadcrumb" i], [class*="breadcrumb" i]');
  if (!nav) return null;
  // A partir do 3º nível o AIR colapsa os ancestrais intermediários num botão de menu ("More"):
  // esse item vira o marcador BREADCRUMB_COLLAPSED, nunca um nome de pasta.
  const parts = Array.from(nav.querySelectorAll('li:not([role="presentation"])'))
    .map((li) => (li.querySelector('button[aria-haspopup="menu"]') && !li.querySelector('a') ? '…' : text(li)))
    .filter((t) => t && t !== '/' && t !== '>' && t !== '›');
  return parts.length > 0 ? parts : null;
})()`;

/** Segmento do breadcrumb que representa um ou mais ancestrais ocultos. */
export const BREADCRUMB_COLLAPSED = '…';

/** Título da pasta sem o total: "<h2>Meu Air (37)</h2>" → "Meu Air". Só aceito se único. */
const FOLDER_HEADING_SCRIPT = String.raw`(() => {
  const text = (el) => (el ? (el.innerText ?? el.textContent ?? '') : '').replace(/\s+/g, ' ').trim();
  const titles = Array.from(document.querySelectorAll('h1, h2')).map((h) => text(h).match(/^(.+?)\s*\(\d+\)$/)).filter(Boolean);
  return titles.length === 1 ? titles[0][1] : null;
})()`;

/**
 * Ícone ChevronRight (Radix Icons) do botão de próxima página do AIR. O botão não
 * tem texto nem aria-label (observado na POC-01B); o ícone é a única identificação.
 */
export const RADIX_CHEVRON_RIGHT_PATH =
  'M6.1584 3.13508C6.35985 2.94621 6.67627 2.95642 6.86514 3.15788L10.6151 7.15788C10.7954 7.3502 10.7954 7.64949 10.6151 7.84182L6.86514 11.8418C6.67627 12.0433 6.35985 12.0535 6.1584 11.8646C5.95694 11.6757 5.94673 11.3593 6.1356 11.1579L9.565 7.49985L6.1356 3.84182C5.94673 3.64036 5.95694 3.32394 6.1584 3.13508Z';

/**
 * O botão de ícone só é aceito se estiver no paginador: contêiner cujos filhos diretos
 * são botões (ou um <span> só com reticências) e cujo texto é só números
 * (ex.: [«][‹][1][2][›][»] ou, com muitas páginas, [«][‹][1][2][...][35][›][»]). Isso exclui
 * as setas do carrossel de recentes ("Next slide") e qualquer outro ícone igual.
 */
// Locator.evaluate não invoca funções passadas como string; o corpo vira função em
// tempo de execução para não carregar helpers do transpilador para a página.
const IN_PAGER = new Function(
  'el',
  String.raw`const group = el.parentElement;
  if (!group) return false;
  const kids = Array.from(group.children);
  const text = (group.innerText ?? group.textContent ?? '').replace(/\s+/g, ' ').trim();
  const ellipsis = (k) => k.tagName === 'SPAN' && /^(\.\.\.|…)$/.test((k.textContent || '').trim());
  return kids.length >= 3 && kids.every((k) => k.tagName === 'BUTTON' || ellipsis(k)) && /^[\d\s.…]+$/.test(text) && /\d/.test(text);`,
) as (el: Element) => boolean;

function identified<T>(value: T | undefined | null, source: 'url' | 'breadcrumb' | 'page-heading' | 'operator', reason: string): Identified<T> {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
    ? { status: 'not-identified', reason }
    : { status: 'identified', value, source };
}

export type DetectOptions = { allowInsecureLocal?: boolean };

/**
 * Identifica o ambiente a partir da página. Cliente e setor só são registrados
 * quando informados pelo implantador: nenhum seletor de UI foi validado para eles.
 * O AIR real não exibe breadcrumb (POC-01B); a pasta atual vem então do título.
 */
export async function detectEnvironment(
  page: Page,
  operator: OperatorContext,
  options: DetectOptions = {},
): Promise<AirEnvironment> {
  let instanceOrigin: Identified<string>;
  let pageUrl: Identified<string>;
  try {
    const url = sanitizeUrl(page.url(), options);
    instanceOrigin = { status: 'identified', value: url.origin, source: 'url' };
    pageUrl = { status: 'identified', value: url.href, source: 'url' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    instanceOrigin = { status: 'not-identified', reason };
    pageUrl = { status: 'not-identified', reason };
  }

  const crumbs = (await page.evaluate(BREADCRUMB_SCRIPT)) as string[] | null;
  const breadcrumb = identified(crumbs, 'breadcrumb', 'Breadcrumb não encontrado na página.');
  const heading = (await page.evaluate(FOLDER_HEADING_SCRIPT)) as string | null;
  // Fora da raiz o AIR exibe breadcrumb E título; se divergirem, a pasta atual não é confirmada.
  const conflict = crumbs && heading !== null && crumbs.at(-1) !== heading;

  return {
    instanceOrigin,
    pageUrl,
    client: identified(operator.client, 'operator', 'Não exposto de forma verificável pela UI; não informado pelo operador.'),
    sector: identified(operator.sector, 'operator', 'Não exposto de forma verificável pela UI; não informado pelo operador.'),
    currentFolder: conflict
      ? { status: 'not-identified', reason: `Breadcrumb ("${crumbs.at(-1)}") e título ("${heading}") divergem.` }
      : crumbs
      ? identified(crumbs.at(-1), 'breadcrumb', 'Breadcrumb sem segmentos.')
      : identified(heading, 'page-heading', 'Sem breadcrumb nem título único "Nome (N)" para determinar a pasta atual.'),
    breadcrumb,
    observedAt: new Date().toISOString(),
  };
}

export type PaginationProbe =
  | { status: 'not-found' }
  | { status: 'ambiguous'; count: number }
  | { status: 'rejected'; reason: string }
  | { status: 'found'; label: string; disabled: boolean };

async function labelOf(control: Locator): Promise<string> {
  const aria = await control.getAttribute('aria-label');
  if (aria) return aria.trim();
  return ((await control.textContent()) ?? '').replace(/\s+/g, ' ').trim();
}

const ICON_SELECTOR = `svg > path[d="${RADIX_CHEVRON_RIGHT_PATH}"]`;

function nextControl(page: Page): Locator {
  return page.getByRole('button', { name: NEXT_PAGE_LABEL }).or(page.locator(`button:has(> ${ICON_SELECTOR})`));
}

/**
 * Candidatos válidos: rótulo da allowlist, ou sem rótulo com o ícone ChevronRight dentro
 * do paginador. Ícones iguais fora do paginador (ex.: carrossel) são descartados.
 */
async function findNextControl(page: Page): Promise<{ probe: PaginationProbe; control?: Locator }> {
  const valid: Array<{ control: Locator; label: string }> = [];
  let discarded = 0;
  for (const control of await nextControl(page).all()) {
    const label = await labelOf(control);
    if (label ? NEXT_PAGE_LABEL.test(label) : (await control.locator(ICON_SELECTOR).count()) === 1 && (await control.evaluate(IN_PAGER))) {
      valid.push({ control, label: label || NEXT_PAGE_ICON_LABEL });
    } else {
      discarded++;
    }
  }
  if (valid.length > 1) return { probe: { status: 'ambiguous', count: valid.length } };
  const [match] = valid;
  if (!match) {
    return {
      probe: discarded > 0 ? { status: 'rejected', reason: `${discarded} botão(ões) com ícone de seta fora de um paginador numérico.` } : { status: 'not-found' },
    };
  }
  const disabled = (await match.control.isDisabled()) || (await match.control.getAttribute('aria-disabled')) === 'true';
  return { probe: { status: 'found', label: match.label, disabled }, control: match.control };
}

/** Localiza o botão de próxima página sem clicar. Ambiguidade = falha fechada. */
export async function probePagination(page: Page): Promise<PaginationProbe> {
  return (await findNextControl(page)).probe;
}

export type PaginationOptions = { timeoutMs: number; pollMs: number };

/**
 * Clica em "próxima página" (única ação de clique da POC-01) e espera até que a
 * listagem mude e se estabilize (duas leituras consecutivas iguais e não vazias).
 * Listagem vazia após avançar é tratada como carregamento em andamento: se
 * persistir até o prazo, o resultado é timeout (falha fechada).
 */
export async function goToNextPage(
  page: Page,
  previousSignature: string,
  options: PaginationOptions,
): Promise<NextPageResult> {
  const { probe, control } = await findNextControl(page);
  if (probe.status === 'not-found') return { status: 'no-next' };
  if (probe.status === 'ambiguous') {
    throw new SafetyViolation(`Encontrados ${probe.count} controles de próxima página; navegação interrompida por ambiguidade.`);
  }
  if (probe.status === 'rejected') throw new SafetyViolation(`Controle de próxima página recusado: ${probe.reason}`);
  if (probe.disabled || !control) return { status: 'no-next' };
  assertReadOnlyAction('pagination-next', probe.label);

  await control.click();

  const deadline = Date.now() + options.timeoutMs;
  let changed = false;
  let lastSignature: string | undefined;
  while (Date.now() < deadline) {
    await page.waitForTimeout(options.pollMs);
    try {
      const listing = await extractListing(page);
      const signature = pageSignature(listing);
      if (signature !== previousSignature) {
        changed = true;
        if (listing.rows.length > 0 && signature === lastSignature) return { status: 'moved' };
      }
      lastSignature = signature;
    } catch {
      // Tabela pode estar sendo re-renderizada; tenta de novo até o prazo.
      lastSignature = undefined;
    }
  }
  return { status: changed ? 'timeout' : 'unchanged' };
}

/**
 * Vai para a página `n` pelo botão numérico do paginador e confirma que a listagem exibida
 * é exatamente a registrada antes (`expectedSignature`). Usado pela leitura recursiva para
 * reposicionar a pasta antes de abrir uma subpasta (não há ação "página anterior").
 * Retorna false se o botão não existir de forma inequívoca ou o conteúdo não conferir.
 */
export async function goToPageNumber(page: Page, n: number, expectedSignature: string, options: PaginationOptions): Promise<boolean> {
  const current = pageSignature(await extractListing(page));
  if (current === expectedSignature) return true;
  const buttons = page.getByRole('button', { name: String(n), exact: true });
  const valid: Locator[] = [];
  for (const b of await buttons.all()) {
    if (((await b.textContent()) ?? '').trim() === String(n) && (await b.evaluate(IN_PAGER))) valid.push(b);
  }
  if (valid.length !== 1) return false;
  assertReadOnlyAction('pagination-page', String(n));
  await valid[0]!.click();

  const deadline = Date.now() + options.timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    await page.waitForTimeout(options.pollMs);
    try {
      const signature = pageSignature(await extractListing(page));
      if (signature === expectedSignature && last === signature) return true;
      last = signature;
    } catch {
      last = undefined;
    }
  }
  return false;
}

/** Adaptador ListingSource sobre a página atual do AIR, com verificação de escopo a cada página. */
export function createAirListingSource(
  page: Page,
  baseline: ScopeFingerprint,
  operator: OperatorContext,
  options: PaginationOptions & DetectOptions,
): ListingSource {
  return {
    read: () => extractListing(page),
    next: (previousSignature) => goToNextPage(page, previousSignature, options),
    checkScope: async () => compareScope(baseline, fingerprintOf(await detectEnvironment(page, operator, options))),
    // Na dúvida (ambíguo/recusado), assume que há mais: o limite gera cobertura parcial.
    hasNext: async () => {
      const probe = await probePagination(page);
      return probe.status === 'not-found' ? false : probe.status === 'found' ? !probe.disabled : true;
    },
  };
}
