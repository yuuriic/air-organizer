import { RADIX_CHEVRON_RIGHT_PATH } from '../../src/air/navigator.js';

/**
 * Fixture HTML SINTÉTICA de navegação entre pastas, reproduzindo o comportamento
 * observado no AIR real na POC-01C (não é cópia do AIR):
 * - SPA: abrir pasta faz pushState para /air/my-air/<id>; a URL não muda ao paginar;
 * - título "<h2>Nome (N)</h2>" com N = filhos diretos; "Caminho" = caminho da pasta exibida;
 * - breadcrumb só fora da raiz: ancestrais são <a> (navegam pelo id), atual é aria-current="page",
 *   separadores usam o MESMO ícone ChevronRight do paginador; do 3º nível em diante os
 *   intermediários colapsam num botão de menu "More" ([raiz] [··· More] [atual]);
 * - seta de voltar do cabeçalho = history.back(); botões numéricos trocam de página (ambos em __navClicks);
 * - toda pasta aberta é registrada em __visits;
 * - tipo na coluna sem cabeçalho: pasta = <svg class="lucide-folder">, arquivo = <img alt="pdf icon">;
 *   na coluna Status, arquivos têm ícones "file-search"/"file-check" (não indicam o tipo);
 * - clique na linha de pasta navega; na linha de ARQUIVO abre um diálogo (visualizador editável);
 * - estrela, compartilhar, checkbox, menu "⋮", menu "More" e reticências do paginador registram cliques proibidos;
 * - ganchos de teste: window.__cfg (mutar a árvore entre leituras), window.__nextStep
 *   ("próxima" defeituoso que avança N páginas) e window.__pageOffset (botão numérico defeituoso).
 */
/** `pathOverride`: "Caminho" exibido na linha, quando diferente do da pasta (anomalia observada no AIR real). */
export type TreeNode = { id: string; name: string; type: 'folder' | 'file'; children?: TreeNode[]; pathOverride?: string };

export type TreeFixtureOptions = {
  root: TreeNode;
  pageSize?: number;
  /** alt do <img> de tipo das linhas de arquivo (AIR real: "pdf icon"); null = sem ícone. */
  fileAlt?: string | null;
  /** Simula navegação para uma pasta diferente da clicada (falha de identidade). */
  misrouteTo?: Record<string, string>;
  /** Faz o "voltar" do cabeçalho levar a esta pasta em vez do histórico (destino errado). */
  backTo?: string;
  /** Estado inicial do filtro de tipo e da busca. */
  typeFilter?: string;
  search?: string;
  renderDelayMs?: number;
  /** Trocar de página cria entrada no histórico (hipótese para o return-failed real da POC-01E). */
  pagingPushesHistory?: boolean;
  /* Causas possíveis de identidade não confirmada após o clique (investigação POC-01E): */
  /** Clicar nestas pastas não navega (URL não muda). */
  inertRows?: string[];
  /** Título exibido diferente do nome da linha, por id. */
  titleOverride?: Record<string, string>;
  /** Breadcrumb trunca nomes longos no texto (não só no CSS): N caracteres + "…". */
  breadcrumbTruncateAt?: number;
  /** Atraso só ao abrir estas pastas: URL muda antes, título e linhas chegam depois. */
  slowOpen?: Record<string, number>;
  /** Ao abrir a pasta da chave, o item do valor some do pai dele (alteração durante a leitura, ADR-013). */
  mutateOnVisit?: Record<string, string>;
  /** O "voltar" do cabeçalho mantém a página corrente (comportamento observado no AIR real, POC-01E). */
  retainPageOnBack?: boolean;
  /** O "voltar" do cabeçalho exibe o pai nesta página (1-based), qualquer que seja a anterior. */
  backLandsOnPage?: number;
};

const ICON = {
  first: 'M6.85355 3.85355L2.14645 7.14645L6.85355 11.8536Z',
  prev: 'M8.84182 3.13514C9.04327 3.32401 9.05348 3.64042 8.86462 3.84188L5.43521 7.49991L8.86462 11.1579Z',
  last: 'M2.14645 11.1464L6.85355 7.85355L2.14645 3.14645Z',
};

export function airTreeHtml(options: TreeFixtureOptions): string {
  const config = JSON.stringify({ pageSize: 30, fileAlt: 'pdf icon', misrouteTo: {}, typeFilter: 'Todos', search: '', renderDelayMs: 0, ...options, next: RADIX_CHEVRON_RIGHT_PATH, icons: ICON });
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>AIR tree fixture</title></head>
<body>
<main>
  <div id="header"><svg id="back" class="lucide lucide-arrow-left cursor-pointer"></svg><h2 id="title"></h2></div>
  <div id="crumbs-slot"></div>
  <div id="toolbar">
    <button role="combobox" id="type-filter"></button>
    <input id="search" />
    <button id="bulk" disabled>Itens selecionados</button>
  </div>
  <table>
    <thead><tr><th></th><th></th><th>Nome</th><th>Descrição</th><th>Caminho</th><th>Data criação</th><th>Status</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="counter"></div>
  <div id="pager"></div>
</main>
<div id="dialog-slot"></div>
<script>
  const cfg = ${config};
  window.__cfg = cfg;
  window.__forbiddenClicks = [];
  window.__navClicks = [];
  window.__visits = [];
  const forbid = (what) => (e) => { e.stopPropagation(); window.__forbiddenClicks.push(what); };
  const byId = new Map();
  const parentOf = new Map();
  (function index(node, parent) {
    byId.set(node.id, node);
    if (parent) parentOf.set(node.id, parent.id);
    for (const c of node.children || []) index(c, node);
  })(cfg.root, null);
  const chain = (id) => { const out = []; for (let x = id; x; x = parentOf.get(x)) out.unshift(byId.get(x)); return out; };
  let page = 0;
  document.getElementById('type-filter').textContent = cfg.typeFilter;
  document.getElementById('search').value = cfg.search;
  document.getElementById('back').addEventListener('click', () => { window.__navClicks.push('back'); if (cfg.backTo) go(cfg.backTo); else history.back(); });
  document.getElementById('bulk').addEventListener('click', forbid('bulk'));

  const svgBtn = (id, d) => '<button id="' + id + '" class="h-8 w-8 p-0"><svg width="15" height="15" viewBox="0 0 15 15" class="h-4 w-4"><path d="' + d + '"></path></svg></button>';
  // Como no AIR real (POC-01E, pasta de 50 páginas): a primeira, a atual e as vizinhas, e a última,
  // com "..." nas lacunas — página 1: [1][2][...][50]; página 4: [1][...][3][4][5][...][50].
  function numbers(pages) {
    const shown = [...new Set([1, page, page + 1, page + 2, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
    return shown.flatMap((n, i) => (i && n - shown[i - 1] > 1 ? [null, n] : [n]));
  }
  function currentId() { const m = location.pathname.match(/my-air\\/([^/]+)$/); return m ? m[1] : cfg.root.id; }

  function go(id) {
    const target = cfg.misrouteTo[id] || id;
    window.__visits.push(target);
    const victim = (cfg.mutateOnVisit || {})[target];
    if (victim) { const p = byId.get(parentOf.get(victim)); p.children = p.children.filter((c) => c.id !== victim); }
    history.pushState({}, '', '/air/my-air/' + target);
    page = 0;
    const slow = (cfg.slowOpen || {})[target];
    if (slow) { document.getElementById('rows').innerHTML = ''; setTimeout(render, slow); } else schedule();
  }
  const crumb = (name) => (cfg.breadcrumbTruncateAt && name.length > cfg.breadcrumbTruncateAt ? name.slice(0, cfg.breadcrumbTruncateAt) + '…' : name);
  function schedule() {
    document.getElementById('rows').innerHTML = '';
    setTimeout(render, cfg.renderDelayMs);
  }

  function render() {
    const node = byId.get(currentId());
    const kids = node.children || [];
    const path = '/' + chain(node.id).map((n) => n.name).join('/');
    const pages = Math.max(1, Math.ceil(kids.length / cfg.pageSize));
    document.getElementById('title').textContent = ((cfg.titleOverride || {})[node.id] || node.name) + ' (' + kids.length + ')';

    const slot = document.getElementById('crumbs-slot');
    const all = chain(node.id);
    const shown = all.length > 2 ? [all[0], null, all[all.length - 1]] : all; // null = colapsado
    const sep = '<li role="presentation"><svg width="15" height="15" viewBox="0 0 15 15"><path d="' + cfg.next + '"></path></svg></li>';
    slot.innerHTML = node.id === cfg.root.id ? '' : '<nav aria-label="breadcrumb"><ol>' + shown.map((a, i) =>
      (i ? sep : '')
      + (a === null
        ? '<li><button type="button" aria-haspopup="menu" class="more"><span role="presentation" aria-hidden="true"><svg></svg><span class="sr-only">More</span></span></button></li>'
        : i === shown.length - 1
        ? '<li><span role="link" aria-disabled="true" aria-current="page">' + crumb(a.name) + '</span></li>'
        : '<li><a data-go="' + a.id + '">' + crumb(a.name) + '</a></li>')).join('') + '</ol></nav>';
    for (const a of slot.querySelectorAll('a[data-go]')) a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.go); });
    slot.querySelector('.more')?.addEventListener('click', forbid('breadcrumb-more'));

    const slice = kids.slice(page * cfg.pageSize, (page + 1) * cfg.pageSize);
    const tbody = document.getElementById('rows');
    tbody.innerHTML = slice.map((k) =>
      '<tr class="cursor-pointer" data-state="false">'
      + '<td><button role="checkbox" aria-label="Select row"></button></td>'
      + '<td><div>' + (k.type === 'folder' ? '<svg class="lucide lucide-folder shrink-0 size-6"></svg>'
        : cfg.fileAlt === null ? '' : '<img class="shrink-0 size-6" src="data:image/svg+xml,%3csvg%3e%3c/svg%3e" alt="' + cfg.fileAlt + '">') + '</div></td>'
      + '<td><div class="truncate" data-state="closed">' + k.name + '</div></td>'
      + '<td><div></div></td>'
      + '<td><div>' + (k.pathOverride || path) + '</div></td>'
      + '<td><div>01/02/2024 às 10:00:00</div></td>'
      + '<td><div>' + (k.type === 'file' ? '<svg class="lucide lucide-file-type2"></svg><svg class="lucide lucide-file-search"></svg><svg class="lucide lucide-file-check"></svg>' : '')
        + '<svg class="lucide lucide-share2 share"></svg><svg class="lucide lucide-star star"></svg></div></td>'
      + '<td><button class="row-menu" aria-haspopup="menu"><svg class="lucide lucide-ellipsis-vertical"></svg></button></td>'
      + '</tr>').join('');
    Array.from(tbody.children).forEach((tr, i) => {
      const item = slice[i];
      tr.addEventListener('click', () => {
        if (item.type === 'file') {
          window.__forbiddenClicks.push('open-file:' + item.name);
          document.getElementById('dialog-slot').innerHTML = '<div role="dialog">Visualizador editável: ' + item.name + '</div>';
        } else {
          if (!(cfg.inertRows || []).includes(item.id)) go(item.id);
        }
      });
      tr.querySelector('[role="checkbox"]').addEventListener('click', forbid('select-row'));
      tr.querySelector('.share').addEventListener('click', forbid('share'));
      tr.querySelector('.star').addEventListener('click', forbid('favorite'));
      tr.querySelector('.row-menu').addEventListener('click', forbid('row-menu'));
    });
    document.getElementById('counter').textContent = '0 de ' + slice.length + ' linhas(s) selecionadas.';

    const pager = document.getElementById('pager');
    pager.innerHTML = svgBtn('first', cfg.icons.first) + svgBtn('prev', cfg.icons.prev)
      + numbers(pages).map((n) => n === null ? '<span>...</span>'
        : '<button class="h-8 w-8 ' + (n - 1 === page ? 'bg-primary' : 'border') + '">' + n + '</button>').join('')
      + svgBtn('next', cfg.next) + svgBtn('last', cfg.icons.last);
    for (const id of ['first', 'prev', 'last']) pager.querySelector('#' + id).addEventListener('click', forbid(id));
    pager.querySelectorAll('span').forEach((s) => s.addEventListener('click', forbid('ellipsis')));
    pager.querySelectorAll('button.border, button.bg-primary').forEach((b) => b.addEventListener('click', () => {
      const n = Number(b.textContent);
      window.__navClicks.push('page:' + n);
      page = Math.min(pages - 1, n - 1 + (window.__pageOffset || 0));
      pagingHistory();
      schedule();
    }));
    pager.querySelector('#first').disabled = page === 0;
    pager.querySelector('#prev').disabled = page === 0;
    pager.querySelector('#last').disabled = page >= pages - 1;
    const next = pager.querySelector('#next');
    next.disabled = page >= pages - 1;
    next.addEventListener('click', () => { page = Math.min(pages - 1, page + (window.__nextStep || 1)); pagingHistory(); schedule(); });
  }
  // Hipótese da POC-01E (return-failed real): trocar de página cria entrada no histórico, mesma URL.
  function pagingHistory() { if (cfg.pagingPushesHistory) history.pushState({}, '', location.pathname); }

  // AIR real (POC-01E): o "voltar" MANTÉM a página corrente (retainPageOnBack). backLandsOnPage força uma página.
  window.addEventListener('popstate', () => { if (cfg.backLandsOnPage) page = cfg.backLandsOnPage - 1; else if (!cfg.retainPageOnBack) page = 0; schedule(); });
  render();
</script>
</body></html>`;
}
