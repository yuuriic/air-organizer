import type { Locator, Page } from 'playwright';
import { activePageOf, pageSignature, type ListingSource, type NextPageResult } from '../core/scanner.js';
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
import { extractListing, type Listing } from './reader.js';

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

/** Botão numérico `n` do paginador, se for único e estiver dentro do paginador. Nunca as reticências (<span>). */
async function pageButton(page: Page, n: number): Promise<Locator | undefined> {
  const valid: Locator[] = [];
  for (const b of await page.getByRole('button', { name: String(n), exact: true }).all()) {
    if (((await b.textContent()) ?? '').trim() === String(n) && (await b.evaluate(IN_PAGER))) valid.push(b);
  }
  return valid.length === 1 ? valid[0] : undefined;
}

/**
 * Espera a página ativa ser `expected`, com conteúdo diferente de `previousSignature`,
 * não vazio e estável (duas leituras iguais). undefined = não confirmada no prazo.
 */
async function waitForActivePage(page: Page, expected: number, previousSignature: string, options: PaginationOptions): Promise<Listing | undefined> {
  const deadline = Date.now() + options.timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    await page.waitForTimeout(options.pollMs);
    try {
      const listing = await extractListing(page);
      const signature = pageSignature(listing);
      if (activePageOf(listing.pageIndicator) === expected && signature !== previousSignature && listing.rows.length > 0 && signature === last) return listing;
      last = signature;
    } catch {
      last = undefined;
    }
  }
  return undefined;
}

export type PageJump = { status: 'reached'; clicks: number } | { status: 'failed'; clicks: number; reason: string };

/**
 * Vai para a página `n` da pasta exibida e confirma que a listagem é exatamente a registrada
 * antes (`expectedSignature`). Usado para reposicionar a pasta antes de abrir uma subpasta.
 *
 * Só usa controles confirmados no AIR real (POC-01B/01D): o botão numérico `n`, se visível;
 * senão, o maior número visível abaixo de `n` e, a partir dele, "próxima página", um passo por
 * vez. Paginadores com reticências ([1][2][...][35]) escondem as páginas intermediárias; as
 * reticências nunca são clicadas, e o campo "Ir" não é usado (sem evidência do DOM real).
 *
 * Cada passo exige a página ativa esperada e uma listagem nova e estável. Conteúdo repetido em
 * outro número de página (loop), página ativa não identificada, controle ausente ou ambíguo e
 * excesso de passos interrompem (falha fechada). Nenhuma URL é montada.
 */
export async function goToPageNumber(page: Page, n: number, expectedSignature: string, options: PaginationOptions): Promise<PageJump> {
  let listing: Listing = await extractListing(page);
  let clicks = 0;
  const failed = (reason: string): PageJump => ({ status: 'failed', clicks, reason });
  // Já exibida: a assinatura registrada inclui o indicador de página. Cobre também pastas
  // de página única, em que o AIR pode não mostrar paginador.
  if (pageSignature(listing) === expectedSignature) return { status: 'reached', clicks };
  const seen = new Map<string, number>();
  // Do pior ponto de partida (página 1, só "1" e "2" visíveis) são no máximo n passos.
  for (let step = 0; step <= n + 1; step++) {
    const signature = pageSignature(listing);
    const active = activePageOf(listing.pageIndicator);
    if (active === undefined) return failed('Página ativa não identificada no paginador.');
    const earlier = seen.get(signature);
    if (earlier !== undefined && earlier !== active) return failed(`Conteúdo da página ${active} repete o da página ${earlier} (loop).`);
    seen.set(signature, active);
    if (active === n) return signature === expectedSignature ? { status: 'reached', clicks } : failed(`O conteúdo da página ${n} difere do lido antes.`);

    const visible = listing.visiblePages ?? [];
    const anchor = Math.max(...visible.filter((v) => v < n));
    let expected: number;
    let control: Locator | undefined;
    if (visible.includes(n) || (Number.isFinite(anchor) && (active > n || active < anchor))) {
      // Salto direto para `n` ou para o ponto visível mais próximo abaixo dele.
      expected = visible.includes(n) ? n : anchor;
      control = await pageButton(page, expected);
      if (!control) return failed(`Botão da página ${expected} ausente ou ambíguo no paginador.`);
      assertReadOnlyAction('pagination-page', String(expected));
    } else if (active < n) {
      const found = await findNextControl(page);
      if (found.probe.status !== 'found' || found.probe.disabled || !found.control) return failed('"Próxima página" indisponível antes de alcançar a página.');
      assertReadOnlyAction('pagination-next', found.probe.label);
      expected = active + 1;
      control = found.control;
    } else {
      return failed(`Nenhum controle confirmado leva à página ${n}.`);
    }

    await control.click();
    clicks++;
    const next = await waitForActivePage(page, expected, signature, options);
    if (!next) return failed(`A página ${expected} não foi confirmada após o clique.`);
    listing = next;
  }
  return failed(`Página ${n} não alcançada dentro do limite de passos.`);
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
