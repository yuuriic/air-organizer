import type { Page } from 'playwright';
import { scanListing } from '../core/scanner.js';
import type { BackOutcome, ChildRef, FolderView, TreeNavigator } from '../core/tree-scanner.js';
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
      return scanListing(source, { maxPages: limits.maxPages, maxItems: limits.maxItems, readTimeoutMs: options.readTimeoutMs, ...(limits.signal ? { signal: limits.signal } : {}) });
    },

    async open(parent, parentScan, child: ChildRef): Promise<FolderView> {
      const recorded = parentScan.pages[child.sourcePage - 1];
      if (!recorded) throw new OpenRefusedError('precondition', 'Página da subpasta não registrada na leitura do pai.');
      // Reposiciona na página da subpasta; o conteúdo precisa ser idêntico ao lido antes.
      // Só páginas efetivamente lidas (portanto dentro de maxPagesPerFolder) são alvo.
      const jump = await goToPageNumber(page, child.sourcePage, recorded.signature, options);
      if (jump.status !== 'reached') {
        throw new OpenRefusedError('precondition', `Não foi possível voltar à página ${child.sourcePage} com o mesmo conteúdo lido antes: ${jump.reason}`);
      }
      // Homônimos: a página reposicionada precisa ter exatamente as linhas com esse nome lidas antes.
      // A linha (rowIndex) é só um localizador temporário; a identidade vem da URL, conferida pelo scanner.
      const expectedSameNameRows = parentScan.items.filter((i) => i.sourcePage === child.sourcePage && i.name === child.name).length;
      const { child: ctx } = await openSubfolder(page, contextOf(parent), { ...child, expectedSameNameRows }, options);
      return view(ctx);
    },

    async back(child, parent): Promise<BackOutcome> {
      try {
        const { contentChanged } = await returnToParent(page, contextOf(child), contextOf(parent), options);
        return contentChanged ? { contentChanged } : {};
      } catch (error) {
        throw new NavigationLostError(error instanceof Error ? error.message : String(error), error);
      }
    },
  };
}
