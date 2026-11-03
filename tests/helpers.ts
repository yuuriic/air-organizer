import type { ListingSource, NextPageResult } from '../src/core/scanner.js';
import type { PageSnapshot, RawRow } from '../src/types/inventory.js';

export function row(name: string, extra: Partial<Record<string, string>> = {}, kindHints: string[] = []): RawRow {
  return {
    cells: {
      '#col0': '',
      Nome: name,
      Descrição: extra.description ?? '',
      Caminho: extra.path ?? `/Raiz/${name}`,
      'Data criação': extra.createdAt ?? '01/02/2024',
      Status: extra.status ?? 'Ativo',
    },
    kindHints,
    idCandidates: {},
  };
}

export function pageOf(names: string[], reportedTotal?: number, pageIndicator?: string): PageSnapshot {
  return { rows: names.map((n) => row(n)), reportedTotal, pageIndicator };
}

type Behavior = {
  /** Resultado forçado de next() a partir da página indicada (1-based). */
  nextOverride?: Record<number, NextPageResult | Error>;
  /** Faz read() nunca resolver na página indicada. */
  hangOnPage?: number;
  failReadOnPage?: number;
  scopeProblemsOnPage?: Record<number, string[]>;
};

/** Fonte simulada: percorre `pages` em sequência; `order` permite simular loops. */
export function simulatedSource(pages: PageSnapshot[], behavior: Behavior = {}, order?: number[]): ListingSource & {
  clicks: number;
} {
  const sequence = order ?? pages.map((_, i) => i);
  let position = 0;
  const source = {
    clicks: 0,
    async read() {
      const pageNumber = position + 1;
      if (behavior.hangOnPage === pageNumber) return new Promise<PageSnapshot>(() => {});
      if (behavior.failReadOnPage === pageNumber) throw new Error('DOM indisponível');
      const page = pages[sequence[position]!];
      if (!page) throw new Error(`página simulada ${pageNumber} inexistente`);
      return page;
    },
    async next(): Promise<NextPageResult> {
      const pageNumber = position + 1;
      const override = behavior.nextOverride?.[pageNumber];
      if (override instanceof Error) throw override;
      if (override) return override;
      if (position + 1 >= sequence.length) return { status: 'no-next' };
      source.clicks++;
      position++;
      return { status: 'moved' };
    },
    async checkScope() {
      return behavior.scopeProblemsOnPage?.[position + 1] ?? [];
    },
  };
  return source;
}
