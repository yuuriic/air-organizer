import type { Page } from 'playwright';
import { createAirListingSource, detectEnvironment, probePagination, type OperatorContext, type PaginationProbe } from '../air/navigator.js';
import { extractListing, ListingNotFoundError } from '../air/reader.js';
import { findDuplicateSuspicions } from '../core/duplicates.js';
import { scanListing } from '../core/scanner.js';
import { fingerprintOf } from '../safety/scope-validator.js';
import { newRunId } from '../storage/export.js';
import type { AirEnvironment, Inventory } from '../types/inventory.js';
import type { OperationalConfig } from './runtime.js';

/** O que a página exibida revela sobre a conexão. Só leitura; nenhum clique. */
export type ConnectionSnapshot = {
  environment: AirEnvironment;
  /** Ausente quando a aba não exibe uma listagem reconhecida. */
  listing?: { headers: string[]; rows: number; pageRowCounter?: number | undefined; reportedTotal?: number | undefined; titleIdentified: boolean; pageIndicator?: string | undefined; idAttributes: string[] };
  paging: PaginationProbe;
};

export async function readConnectionSnapshot(page: Page, operator: OperatorContext): Promise<ConnectionSnapshot> {
  const environment = await detectEnvironment(page, operator);
  let listing: ConnectionSnapshot['listing'];
  try {
    const l = await extractListing(page);
    listing = {
      headers: l.headers,
      rows: l.rows.length,
      pageRowCounter: l.pageRowCounter,
      reportedTotal: l.reportedTotal,
      titleIdentified: Boolean(l.folderTitle),
      pageIndicator: l.pageIndicator,
      idAttributes: [...new Set(l.rows.flatMap((r) => Object.keys(r.idCandidates)))],
    };
  } catch (error) {
    if (!(error instanceof ListingNotFoundError)) throw error;
  }
  return { environment, ...(listing ? { listing } : {}), paging: await probePagination(page) };
}

export const describePaging = (probe: PaginationProbe): string =>
  probe.status === 'found'
    ? `botão "${probe.label}" ${probe.disabled ? '(desabilitado)' : '(habilitado)'}`
    : probe.status === 'ambiguous'
      ? `ambíguo (${probe.count} controles)`
      : probe.status === 'rejected'
        ? `recusado (${probe.reason})`
        : 'não encontrado (página única ou seletor não suportado)';

/** Lê todas as páginas da pasta exibida, sem entrar em subpastas. */
export async function readFolderInventory(page: Page, env: AirEnvironment, operator: OperatorContext, config: OperationalConfig): Promise<Inventory> {
  const startedAt = new Date().toISOString();
  const source = createAirListingSource(page, fingerprintOf(env), operator, { timeoutMs: config.pageTimeoutMs, pollMs: config.pollMs });
  const result = await scanListing(source, { maxPages: config.maxPages, readTimeoutMs: config.pageTimeoutMs });
  return {
    schemaVersion: 1,
    tool: 'air-organizer',
    runId: newRunId(new Date(startedAt)),
    mode: 'current-folder',
    readOnly: true,
    environment: env,
    startedAt,
    finishedAt: new Date().toISOString(),
    coverage: result.coverage,
    items: result.items,
    duplicateSuspicions: findDuplicateSuspicions(result.items),
  };
}
