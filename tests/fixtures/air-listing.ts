import { RADIX_CHEVRON_RIGHT_PATH } from '../../src/air/navigator.js';

/**
 * Fixture HTML SINTÉTICA inspirada na estrutura descrita em ARCHITECTURE.md §2.1
 * (tabela Nome/Descrição/Caminho/Data criação/Status, checkboxes "Select row",
 * contador "X de N linhas(s) selecionadas") e na estrutura observada no AIR real
 * na POC-01B (título "Pasta (N)" com o total, contador que conta só a página).
 * Não é cópia do AIR real.
 *
 * Variante 'air-real': sem breadcrumb, paginador só com ícones Radix sem rótulo
 * ([«][‹][1][2][›][»]), carrossel de recentes com "Next slide" e botão de ações por linha.
 *
 * Contém controles perigosos ("Mover para", "Excluir", seleção) que registram
 * cliques em window.__forbiddenClicks, para provar que a automação não os aciona.
 */
export type FixtureOptions = {
  names: string[];
  pageSize: number;
  /** Atraso de renderização após trocar de página (simula carregamento assíncrono). */
  renderDelayMs?: number;
  /** 'stuck': o botão Próxima não altera a listagem. 'loop': da última página volta para a primeira. */
  mode?: 'normal' | 'stuck' | 'loop';
  breadcrumb?: string[];
  variant?: 'labeled' | 'air-real';
};

// Paths dos Radix Icons usados pelo paginador do AIR (DoubleArrowLeft, ChevronLeft, ChevronRight, DoubleArrowRight).
const ICON = {
  first: 'M6.85355 3.85355L2.14645 7.14645L6.85355 11.8536Z',
  prev: 'M8.84182 3.13514C9.04327 3.32401 9.05348 3.64042 8.86462 3.84188L5.43521 7.49991L8.86462 11.1579Z',
  next: RADIX_CHEVRON_RIGHT_PATH,
  last: 'M2.14645 11.1464L6.85355 7.85355L2.14645 3.14645Z',
};
const iconButton = (id: string, d: string) =>
  `<button id="${id}" class="h-8 w-8 p-0"><svg width="15" height="15" viewBox="0 0 15 15" class="h-4 w-4"><path d="${d}"></path></svg></button>`;

export function airListingHtml(options: FixtureOptions): string {
  const config = JSON.stringify({
    mode: 'normal',
    renderDelayMs: 0,
    breadcrumb: ['Setor Teste', 'Raiz'],
    variant: 'labeled',
    ...options,
  });
  const airReal = options.variant === 'air-real';
  const pager = airReal
    ? `<div><p>Registros por página</p><button role="combobox">30</button></div>
  <div id="pager">${iconButton('first', ICON.first)}${iconButton('prev', ICON.prev)}${iconButton('next', ICON.next)}${iconButton('last', ICON.last)}</div>`
    : `<div><span id="indicator"></span>
    <button id="prev"><span class="sr-only">Anterior</span></button>
    <button id="next" aria-label="Próxima página">›</button>
  </div>`;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>AIR fixture</title></head>
<body>
  ${airReal ? '' : '<nav aria-label="breadcrumb"><ol id="crumbs"></ol></nav>'}
  <h2 id="title"></h2>
  ${airReal ? `<div role="region"><button id="slide-prev" disabled>Previous slide</button><h3>recente.pdf</h3>${iconButton('slide-next-icon', ICON.next)}<button id="slide-next">Next slide</button></div>` : ''}
  <div>
    <button id="bulk">Itens selecionados</button>
    <button id="move">Mover para</button>
    <button id="delete">Excluir</button>
  </div>
  <table>
    <thead><tr>
      <th><button role="checkbox" aria-label="Select all"></button></th>
      <th>Nome</th><th>Descrição</th><th>Caminho</th><th>Data criação</th><th>Status</th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="counter"></div>
  ${pager}
<script>
  const cfg = ${config};
  window.__forbiddenClicks = [];
  let page = 0;
  const total = cfg.names.length;
  const pages = Math.max(1, Math.ceil(total / cfg.pageSize));
  const airReal = cfg.variant === 'air-real';
  if (!airReal) document.getElementById('crumbs').innerHTML = cfg.breadcrumb.map((c) => '<li>' + c + '</li>').join('');
  document.getElementById('title').textContent = cfg.breadcrumb[cfg.breadcrumb.length - 1] + ' (' + total + ')';
  for (const id of ['bulk', 'move', 'delete', 'slide-prev', 'slide-next', 'slide-next-icon', 'first', 'last']) {
    document.getElementById(id)?.addEventListener('click', () => window.__forbiddenClicks.push(id));
  }
  document.querySelector('[aria-label="Select all"]').addEventListener('click', () => window.__forbiddenClicks.push('select-all'));

  function render() {
    const slice = cfg.names.slice(page * cfg.pageSize, (page + 1) * cfg.pageSize);
    const tbody = document.getElementById('rows');
    tbody.innerHTML = slice.length === 0
      ? '<tr><td colspan="6">Nenhum resultado.</td></tr>'
      : slice.map((name, i) => {
          const isFile = name.endsWith('.pdf');
          const icon = isFile ? '<svg class="lucide lucide-file-text"></svg>' : '<svg class="lucide lucide-folder"></svg>';
          return '<tr data-row-id="r' + (page * cfg.pageSize + i) + '">'
            + '<td><button role="checkbox" aria-label="Select row"></button></td>'
            + '<td>' + icon + '<a href="#">' + name + '</a></td>'
            + '<td></td>'
            + '<td>' + cfg.breadcrumb.join('/') + '/' + name + '</td>'
            + '<td>0' + ((i % 9) + 1) + '/02/2024 10:00</td>'
            + '<td>Ativo</td>'
            + (airReal ? '<td><button class="row-actions"><svg class="lucide lucide-ellipsis-vertical"></svg></button></td>' : '')
            + '</tr>';
        }).join('');
    for (const b of tbody.querySelectorAll('[aria-label="Select row"], .row-actions')) {
      b.addEventListener('click', () => window.__forbiddenClicks.push('row-control'));
    }
    // Como no AIR real: o contador conta só as linhas da página exibida.
    document.getElementById('counter').textContent = '0 de ' + slice.length + ' linhas(s) selecionadas.';
    if (airReal) {
      // Botões numéricos são filhos diretos do paginador, entre "anterior" e "próxima".
      for (const b of document.querySelectorAll('#pager > .num')) b.remove();
      document.getElementById('next').insertAdjacentHTML('beforebegin', Array.from({ length: pages }, (_, i) =>
        '<button class="num h-8 w-8 ' + (i === page ? 'bg-primary' : 'border') + '">' + (i + 1) + '</button>').join(''));
      document.getElementById('first').disabled = page === 0;
      document.getElementById('prev').disabled = page === 0;
      document.getElementById('last').disabled = page >= pages - 1;
    } else {
      document.getElementById('indicator').textContent = 'Página ' + (page + 1) + ' de ' + pages;
    }
    const next = document.getElementById('next');
    next.disabled = cfg.mode === 'normal' && page >= pages - 1;
  }

  document.getElementById('next').addEventListener('click', () => {
    if (cfg.mode === 'stuck') return;
    const target = page >= pages - 1 ? 0 : page + 1; // 'loop' volta ao início
    document.getElementById('rows').innerHTML = '';
    setTimeout(() => { page = target; render(); }, cfg.renderDelayMs);
  });
  render();
</script>
</body></html>`;
}
