import type { Page } from 'playwright';
import type { PageSnapshot, RawRow } from '../types/inventory.js';

export { inferKind, parseRows } from '../core/records.js';

/**
 * Script executado no navegador para extrair a listagem. Somente lê o DOM:
 * não clica, não altera atributos e não lê conteúdo de documentos.
 *
 * Mantido como string (e não como função TS) para que o transpilador não injete
 * helpers que não existem no contexto da página.
 *
 * Validado no AIR real (POC-01B, "Meu Air", 37 itens em 2 páginas de 30):
 * - tabela com cabeçalhos Nome/Descrição/Caminho/Data criação/Status;
 * - o total da pasta aparece no título: <h2>Nome da pasta (37)</h2>;
 * - "X de N linhas(s) selecionadas" conta só as linhas da PÁGINA (N = 30), não da pasta;
 * - a página ativa é o botão numérico com destaque (bg-primary) no paginador.
 * POC-01C (subpasta de 2º nível):
 * - o tipo é o ícone lucide da coluna sem cabeçalho antes de "Nome" (pasta = "folder");
 * - "Caminho" é o caminho completo da pasta EXIBIDA (pai do item), igual para todas as linhas;
 * - acima da tabela há um filtro de tipo ("Todos" | "Arquivos" | "Pastas") e uma busca:
 *   com filtro diferente de "Todos" ou busca preenchida, a listagem não é a pasta inteira.
 */
const EXTRACT_LISTING_SCRIPT = String.raw`(() => {
  const norm = (s) => (s || '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const text = (el) => (el ? (el.innerText ?? el.textContent ?? '') : '').replace(/\s+/g, ' ').trim();

  const tables = Array.from(document.querySelectorAll('table'));
  const table = tables.find((t) => Array.from(t.querySelectorAll('thead th')).some((th) => norm(text(th)) === 'nome'));
  if (!table) return { found: false };

  const headers = Array.from(table.querySelectorAll('thead th')).map((th, i) => text(th) || ('#col' + i));
  // Coluna de ícone de tipo: a coluna sem cabeçalho imediatamente antes de "Nome".
  const nameIdx = headers.findIndex((h) => norm(h) === 'nome');
  // Uma coluna de seleção (checkbox) nunca é a coluna de ícone.
  const checkbox = '[role="checkbox"], input[type="checkbox"]';
  const iconTh = nameIdx > 0 ? table.querySelectorAll('thead th')[nameIdx - 1] : null;
  const iconIdx = iconTh && /^#col\d+$/.test(headers[nameIdx - 1]) && !iconTh.querySelector(checkbox)
    && !Array.from(table.querySelectorAll('tbody tr')).some((tr) => tr.querySelectorAll('td')[nameIdx - 1]?.querySelector(checkbox))
    ? nameIdx - 1 : -1;
  const rows = [];
  for (const tr of Array.from(table.querySelectorAll('tbody tr'))) {
    const tds = Array.from(tr.querySelectorAll('td'));
    if (tds.length < headers.length) continue; // linha de "sem resultados" (colspan)
    const cells = {};
    tds.forEach((td, i) => { cells[headers[i] ?? ('#col' + i)] = text(td); });

    const kindHints = [];
    for (const el of Array.from(tr.querySelectorAll('svg, img, i, [aria-label], [title], [data-type], [data-kind]'))) {
      if (el.matches('button[role="checkbox"], [aria-label="Select row"], input[type="checkbox"]')) continue;
      for (const attr of ['aria-label', 'title', 'alt', 'data-type', 'data-kind', 'data-icon', 'class']) {
        const v = el.getAttribute(attr);
        if (v) kindHints.push(attr + '=' + v.slice(0, 120));
      }
    }

    const idCandidates = {};
    for (const attr of Array.from(tr.attributes)) {
      if (attr.name === 'id' || (attr.name.startsWith('data-') && /id|key/i.test(attr.name))) {
        idCandidates[attr.name] = attr.value;
      }
    }
    // Ícone da coluna de tipo: svg lucide → nome ("folder"); <img> → "img:<alt>" ("img:pdf icon").
    // Existindo a coluna, typeIcon é sempre definido ('' = nenhum ou mais de um ícone), para que
    // pistas de outras colunas (ex.: ícones de Status "file-search") nunca decidam o tipo.
    if (iconIdx >= 0) {
      const icons = Array.from(tds[iconIdx].querySelectorAll('svg, img')).map((el) =>
        el.tagName === 'IMG'
          ? 'img:' + (el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().toLowerCase()
          : ((el.getAttribute('class') || '').split(/\s+/).find((c) => c.startsWith('lucide-')) || '').slice('lucide-'.length),
      ).filter(Boolean);
      rows.push({ cells, kindHints, idCandidates, typeIcon: icons.length === 1 ? icons[0] : '' });
    } else {
      rows.push({ cells, kindHints, idCandidates });
    }
  }

  const body = text(document.body);
  const counterMatch = body.match(/\d+\s+de\s+(\d+)\s+linhas?(?:\(s\))?\s+selecionad/i);
  // Título "Nome (N)": só é aceito se for único na página (falha fechada).
  const headings = Array.from(document.querySelectorAll('h1, h2'))
    .map((h) => text(h).match(/^(.+?)\s*\((\d+)\)$/))
    .filter(Boolean);
  const heading = headings.length === 1 ? headings[0] : null;
  const pageMatch = body.match(/p[aá]gina\s+\d+\s+de\s+\d+/i);
  // Barra de filtros acima da tabela: combobox de tipo ("Todos"/"Arquivos"/"Pastas") e busca.
  const before = (el) => !!(el.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING);
  const filters = Array.from(document.querySelectorAll('[role="combobox"], select')).filter(before).map(text);
  const searches = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'))
    .filter((i) => before(i) && i.offsetParent !== null);
  // Paginador: contêiner cujos filhos diretos são só botões e cujo texto é só números.
  const pagers = Array.from(document.querySelectorAll('div')).filter((d) => {
    const kids = Array.from(d.children);
    const ellipsis = (k) => k.tagName === 'SPAN' && /^(\.\.\.|…)$/.test(text(k));
    return kids.length >= 3 && kids.every((k) => k.tagName === 'BUTTON' || ellipsis(k)) && /^[\d\s.…]+$/.test(text(d)) && /\d/.test(text(d));
  });
  const numbered = pagers.length === 1 ? Array.from(pagers[0].children).filter((b) => b.tagName === 'BUTTON' && /^\d+$/.test(text(b))) : [];
  const active = numbered.filter((b) => b.classList.contains('bg-primary'));
  return {
    found: true,
    headers,
    rows,
    reportedTotal: heading ? Number(heading[2]) : undefined,
    folderTitle: heading ? heading[1] : undefined,
    pageRowCounter: counterMatch ? Number(counterMatch[1]) : undefined,
    typeFilter: filters.length === 1 ? filters[0] : filters.length > 1 ? filters.join(' | ') : undefined,
    searchActive: searches.some((i) => i.value.trim() !== ''),
    pageIndicator: pageMatch ? pageMatch[0] : active.length === 1 ? 'página ativa ' + text(active[0]) : undefined,
    // Botões numéricos visíveis (as reticências são <span> e nunca entram aqui).
    visiblePages: numbered.length > 0 ? numbered.map((b) => Number(text(b))) : undefined,
  };
})()`;

type ExtractionResult =
  | { found: false }
  | {
      found: true;
      headers: string[];
      rows: RawRow[];
      reportedTotal?: number;
      folderTitle?: string;
      pageRowCounter?: number;
      typeFilter?: string;
      searchActive?: boolean;
      pageIndicator?: string;
      visiblePages?: number[];
    };

export class ListingNotFoundError extends Error {
  constructor() {
    super('Nenhuma tabela de listagem com coluna "Nome" foi encontrada na página.');
    this.name = 'ListingNotFoundError';
  }
}

export type Listing = PageSnapshot & { headers: string[]; folderTitle?: string; visiblePages?: number[] };

export async function extractListing(page: Page): Promise<Listing> {
  const result = (await page.evaluate(EXTRACT_LISTING_SCRIPT)) as ExtractionResult;
  if (!result.found) throw new ListingNotFoundError();
  return {
    headers: result.headers,
    rows: result.rows,
    reportedTotal: result.reportedTotal,
    folderTitle: result.folderTitle,
    pageRowCounter: result.pageRowCounter,
    typeFilter: result.typeFilter,
    searchActive: result.searchActive,
    pageIndicator: result.pageIndicator,
    ...(result.visiblePages ? { visiblePages: result.visiblePages } : {}),
  };
}
