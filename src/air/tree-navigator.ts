import type { Page } from 'playwright';
import { scanListing } from '../core/scanner.js';
import type { ChildRef, FolderView, TreeNavigator } from '../core/tree-scanner.js';
import { OpenRefusedError, fingerprintOf } from '../safety/scope-validator.js';
import type { ScanResult } from '../types/inventory.js';
import { NavigationLostError, openSubfolder, readFolderContext, returnToParent, type FolderContext, type FolderNavigationOptions } from './folders.js';
import { createAirListingSource, detectEnvironment, goToPageNumber, type OperatorContext } from './navigator.js';
import { extractListing } from './reader.js';

/**
 * Adaptador TreeNavigator sobre a UI do AIR. Cliques possíveis, todos verificados:
 * "próxima página", botão numérico do paginador (reposicionar), nome da subpasta e
 * link do pai no breadcrumb / "voltar" do cabeçalho.
 */
export function createAirTreeNavigator(
  page: Page,
  operator: OperatorContext,
  options: FolderNavigationOptions & { readTimeoutMs: number },
): TreeNavigator {
  const contexts = new Map<string, FolderContext>();

  const view = (ctx: FolderContext): FolderView => {
    contexts.set(ctx.pageUrl, ctx);
    return { key: ctx.pageUrl, title: ctx.title, total: ctx.total, ...(ctx.path ? { path: ctx.path } : {}) };
  };
  const contextOf = (v: FolderView): FolderContext => {
    const ctx = contexts.get(v.key);
    if (!ctx) throw new Error('Contexto da pasta não registrado nesta execução.');
    return ctx;
  };

  return {
    current: async () => view(await readFolderContext(page)),

    async scan(limits): Promise<ScanResult> {
      const listing = await extractListing(page);
      // A leitura precisa começar na 1ª página (o AIR abre pastas na página 1).
      if (listing.pageIndicator !== undefined && !/(^|\s)1$|p[aá]gina\s+1\s+de/i.test(listing.pageIndicator)) {
        throw new Error('A pasta não está na primeira página; leitura recusada.');
      }
      const env = await detectEnvironment(page, operator);
      const source = createAirListingSource(page, fingerprintOf(env), operator, options);
      return scanListing(source, { maxPages: limits.maxPages, maxItems: limits.maxItems, readTimeoutMs: options.readTimeoutMs });
    },

    async open(parent, parentScan, child: ChildRef): Promise<FolderView> {
      const recorded = parentScan.pages[child.sourcePage - 1];
      if (!recorded) throw new OpenRefusedError('precondition', 'Página da subpasta não registrada na leitura do pai.');
      // Reposiciona na página da subpasta; o conteúdo precisa ser idêntico ao lido antes.
      if (!(await goToPageNumber(page, child.sourcePage, recorded.signature, options))) {
        throw new OpenRefusedError('precondition', `Não foi possível voltar à página ${child.sourcePage} com o mesmo conteúdo lido antes.`);
      }
      const { child: ctx } = await openSubfolder(page, contextOf(parent), child, options);
      return view(ctx);
    },

    async back(child, parent): Promise<void> {
      try {
        await returnToParent(page, contextOf(child), contextOf(parent), options);
      } catch (error) {
        throw new NavigationLostError(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
