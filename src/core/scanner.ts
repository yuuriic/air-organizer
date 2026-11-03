import { createHash } from 'node:crypto';
import { parseRows } from './records.js';
import type {
  AirItem,
  CoverageReport,
  PageReadResult,
  PageSnapshot,
  ScanIssue,
  ScanResult,
} from '../types/inventory.js';

/** Resultado de uma tentativa de avançar de página. */
export type NextPageResult =
  | { status: 'moved' }
  | { status: 'no-next' }
  | { status: 'unchanged' }
  | { status: 'timeout' };

/**
 * Fonte de páginas da listagem. O adaptador do AIR (Playwright) e os testes
 * (dados simulados) implementam esta interface; o scanner não conhece o navegador.
 */
export interface ListingSource {
  read(): Promise<PageSnapshot>;
  /** Avança e espera a listagem mudar em relação a `previousSignature`. */
  next(previousSignature: string): Promise<NextPageResult>;
  /** Retorna problemas de escopo (origem/setor/breadcrumb mudaram). Vazio = ok. */
  checkScope?(): Promise<string[]>;
  /** Existe próxima página? Sem clicar. Usado só ao atingir um limite; ausente = assume que sim. */
  hasNext?(): Promise<boolean>;
}

export type ScanOptions = {
  maxPages: number;
  /** Limite de itens únicos; verificado ao fim de cada página (a página corrente é lida inteira). */
  maxItems?: number;
  readTimeoutMs: number;
  now?: () => string;
  trustedIdAttribute?: string;
};

/** Assinatura do conteúdo exibido. Inclui todas as células para não depender só do nome. */
export function pageSignature(snapshot: Pick<PageSnapshot, 'rows' | 'pageIndicator'>): string {
  const hash = createHash('sha256');
  hash.update(snapshot.pageIndicator ?? '');
  for (const row of snapshot.rows) {
    hash.update('\u0001');
    for (const [key, value] of Object.entries(row.cells).sort(([a], [b]) => a.localeCompare(b))) {
      hash.update(`${key}\u0000${value}\u0002`);
    }
  }
  return hash.digest('hex');
}

/**
 * Número da página ativa a partir do indicador da listagem: "Página 3 de 9" (rótulo textual)
 * ou "página ativa 3" (botão numérico destacado no paginador do AIR). undefined = não exibido.
 */
export function activePageOf(indicator: string | undefined): number | undefined {
  const match = indicator?.match(/^p[aá]gina\s+(?:ativa\s+)?(\d+)(?:\s+de\s+\d+)?$/i);
  return match ? Number(match[1]) : undefined;
}

class TimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${label} excedeu ${ms} ms.`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lê todas as páginas da listagem atual, sem entrar em subpastas.
 * Para ao detectar fim, loop, página inalterada, timeout, erro ou mudança de escopo,
 * e sempre devolve o que foi lido junto com o relatório de cobertura.
 */
export async function scanListing(source: ListingSource, options: ScanOptions): Promise<ScanResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const items: AirItem[] = [];
  const pages: PageReadResult[] = [];
  const issues: ScanIssue[] = [];
  const seenSignatures = new Map<string, number>();
  const seenKeys = new Set<string>();
  let repeatedObservations = 0;
  let observed = 0;
  let reportedTotal: number | undefined;
  let firstPageSize: number | undefined;
  let stopReason: CoverageReport['stopReason'] = 'error';

  for (let pageNumber = 1; ; pageNumber++) {
    let snapshot: PageSnapshot;
    try {
      snapshot = await withTimeout(source.read(), options.readTimeoutMs, `Leitura da página ${pageNumber}`);
    } catch (error) {
      const timedOut = error instanceof TimeoutError;
      issues.push({ kind: timedOut ? 'timeout' : 'read-error', pageNumber, message: errorMessage(error) });
      stopReason = timedOut ? 'timeout' : 'error';
      break;
    }

    const signature = pageSignature(snapshot);
    const earlier = seenSignatures.get(signature);
    if (earlier !== undefined) {
      issues.push({
        kind: 'loop-detected',
        pageNumber,
        message: `Conteúdo da página ${pageNumber} é idêntico ao da página ${earlier}; paginação interrompida.`,
      });
      stopReason = 'loop';
      break;
    }
    seenSignatures.set(signature, pageNumber);

    // Com o paginador exibindo a página ativa, ela precisa ser a esperada (ex.: a leitura não
    // começou na página 1, ou o "próxima" pulou páginas).
    const active = activePageOf(snapshot.pageIndicator);
    if (active !== undefined && active !== pageNumber) {
      issues.push({ kind: 'page-mismatch', pageNumber, message: `O paginador indica a página ${active}, mas a leitura esperava a página ${pageNumber}.` });
      stopReason = 'error';
      break;
    }

    if (snapshot.reportedTotal !== undefined) {
      if (reportedTotal !== undefined && reportedTotal !== snapshot.reportedTotal) {
        issues.push({
          kind: 'count-mismatch',
          pageNumber,
          message: `Total exibido mudou de ${reportedTotal} para ${snapshot.reportedTotal} durante a leitura.`,
        });
      }
      reportedTotal ??= snapshot.reportedTotal;
    }
    firstPageSize ??= snapshot.rows.length;
    if ((snapshot.typeFilter !== undefined && !/^todos$/i.test(snapshot.typeFilter.trim())) || snapshot.searchActive) {
      issues.push({
        kind: 'filter-active',
        pageNumber,
        message: `Listagem filtrada (tipo: "${snapshot.typeFilter ?? '?'}"${snapshot.searchActive ? ', busca preenchida' : ''}); não representa a pasta inteira.`,
      });
    }
    if (snapshot.pageRowCounter !== undefined && snapshot.pageRowCounter !== snapshot.rows.length) {
      issues.push({
        kind: 'count-mismatch',
        pageNumber,
        message: `O contador da página indica ${snapshot.pageRowCounter} linha(s), mas ${snapshot.rows.length} foram lidas.`,
      });
    }

    const parsed = parseRows(snapshot.rows, {
      pageNumber,
      observedAt: now(),
      trustedIdAttribute: options.trustedIdAttribute,
    });
    issues.push(...parsed.issues);
    for (const item of parsed.items) {
      observed++;
      if (seenKeys.has(item.observationKey)) {
        repeatedObservations++;
        continue;
      }
      seenKeys.add(item.observationKey);
      items.push(item);
    }
    pages.push({ pageNumber, signature, rowCount: snapshot.rows.length, pageIndicator: snapshot.pageIndicator });

    if (source.checkScope) {
      const scopeProblems = await source.checkScope();
      if (scopeProblems.length > 0) {
        for (const message of scopeProblems) issues.push({ kind: 'scope-changed', pageNumber, message });
        stopReason = 'scope-changed';
        break;
      }
    }

    const pagesLimit = pageNumber >= options.maxPages;
    const itemsLimit = options.maxItems !== undefined && items.length >= options.maxItems;
    if (pagesLimit || itemsLimit) {
      // Limite atingido exatamente na última página não é cobertura parcial.
      if (source.hasNext && !(await source.hasNext())) {
        stopReason = 'last-page';
        break;
      }
      if (pagesLimit) {
        issues.push({ kind: 'max-pages-reached', pageNumber, message: `Limite de ${options.maxPages} páginas atingido.` });
        stopReason = 'max-pages';
      } else {
        issues.push({ kind: 'max-items-reached', pageNumber, message: `Limite de ${options.maxItems} itens atingido.` });
        stopReason = 'max-items';
      }
      break;
    }

    let next: NextPageResult;
    try {
      next = await source.next(signature);
    } catch (error) {
      issues.push({ kind: 'navigation-error', pageNumber, message: errorMessage(error) });
      stopReason = 'error';
      break;
    }
    if (next.status === 'no-next') {
      stopReason = 'last-page';
      break;
    }
    if (next.status === 'unchanged') {
      issues.push({ kind: 'page-unchanged', pageNumber, message: `Após avançar da página ${pageNumber}, a listagem não mudou.` });
      stopReason = 'error';
      break;
    }
    if (next.status === 'timeout') {
      issues.push({ kind: 'timeout', pageNumber, message: `Tempo esgotado aguardando a página ${pageNumber + 1}.` });
      stopReason = 'timeout';
      break;
    }
  }

  // Estimativa: só possível com total exibido e mais de uma página lida
  // (o tamanho da primeira página é tomado como tamanho de página).
  let expectedPages: number | undefined;
  if (reportedTotal !== undefined && firstPageSize && (pages.length > 1 || reportedTotal <= firstPageSize)) {
    expectedPages = Math.max(1, Math.ceil(reportedTotal / firstPageSize));
  }
  const unreadPages: number[] = [];
  if (expectedPages !== undefined) {
    for (let p = pages.length + 1; p <= expectedPages; p++) unreadPages.push(p);
  }
  if (stopReason === 'last-page' && reportedTotal !== undefined && items.length !== reportedTotal) {
    issues.push({
      kind: 'count-mismatch',
      message: `Itens únicos lidos (${items.length}) diferem do total exibido no título da pasta (${reportedTotal}).`,
    });
  }

  const blocking = issues.some((i) => i.kind !== 'parse-warning');
  const coverage: CoverageReport = {
    pagesRead: pages.length,
    expectedPages,
    itemsObserved: observed,
    uniqueItems: items.length,
    repeatedObservations,
    reportedTotal,
    unreadPages,
    complete: stopReason === 'last-page' && !blocking && repeatedObservations === 0 && unreadPages.length === 0,
    stopReason,
    issues,
  };
  return { items, pages, coverage };
}
