import type { MovementInspectionView, MovementPreviewView, SafeError } from '../../app/controller.js';
import type { ProposalPreview, SelectionNode } from '../../app/movement-review.js';
import { bullets, facts } from './analysis.js';
import { byId, call, clearMessage, confirmDialog, el, showMessage } from './dom.js';

/**
 * Prévia de movimentações na tela Planejamento. A janela só recebe identificadores e rótulos neutros.
 * Nomes só existem em `names`, depois de confirmação; ocultar descarta o mapa e redesenha tudo. Só
 * texto dos elementos: nada em atributos, títulos ou rótulos de acessibilidade.
 *
 * `epoch` muda sempre que a seleção muda: resposta de um pedido anterior é descartada, inclusive erro.
 */

const KIND_LABEL: Record<ProposalPreview['kind'], string> = { 'move-file': 'Arquivo', 'move-folder': 'Pasta inteira', 'consolidate-folder': 'Consolidação (agrupamento)' };
const STATE_LABEL: Record<ProposalPreview['state'], string> = { generated: 'Gerada', blocked: 'Bloqueada', 'ready-for-review': 'Apta para revisão' };
const GROUP_LABEL: Record<NonNullable<ProposalPreview['group']>['status'], string> = {
  'all-ready': 'todas as operações aptas',
  'partially-blocked': 'parcialmente bloqueada',
  'fully-blocked': 'totalmente bloqueada',
  empty: 'sem conteúdo a consolidar',
};
const MODE_LABEL: Record<string, string> = { folder: 'Levar a pasta para dentro do destino', 'folder-contents': 'Consolidar o conteúdo da pasta no destino' };
const REVEAL_WARNING = ['A revelação pode mostrar nomes de pastas e arquivos, que podem conter dados pessoais ou sensíveis.', 'Eles ficam visíveis nesta janela até você ocultá-los. Não compartilhe a tela sem autorização.'];
/** Texto e símbolo, além da cor: o estado não depende só da aparência. */
const STATE_TAG: Record<ProposalPreview['state'], { className: string; symbol: string }> = {
  generated: { className: 'tag', symbol: '' },
  blocked: { className: 'tag state-blocked', symbol: '⚠ ' },
  'ready-for-review': { className: 'tag state-ready', symbol: '○ ' },
};
const IDENTITY_NOTE: Record<SelectionNode['identity'], string> = { observed: '', derived: ' · caminho derivado', unavailable: ' · sem caminho comprovável', ambiguous: ' · identidade ambígua' };

let inspection: MovementInspectionView | undefined;
let preview: MovementPreviewView | undefined;
/** A seleção que gerou a prévia exibida, guardada no pedido: não acompanha mudanças posteriores. */
let generatedFrom: { inventory: string; source: string; destination: string; mode: string | undefined } | undefined;
let names: Record<string, string> | undefined;
let epoch = 0;

const nodes = () => inspection?.tree ?? [];
const nodeById = (id: string | undefined) => nodes().find((n) => n.id === id);

function neutral(n: SelectionNode): string {
  if (n.kind === 'file') return `Arquivo ${n.id}`;
  if (n.kind === 'unknown') return `Item de tipo desconhecido ${n.id}`;
  return `Pasta ${n.id} · ${n.folders ?? 0} subpasta(s), ${n.files ?? 0} arquivo(s)`;
}
function label(n: SelectionNode): string {
  const name = names?.[n.id];
  return name === undefined ? neutral(n) : `${n.id} · ${name}`;
}
const described = (id: string | undefined) => {
  const n = nodeById(id);
  return n ? label(n) : 'não identificada com segurança';
};

const sourceSelect = () => byId<HTMLSelectElement>('move-source');
const destinationSelect = () => byId<HTMLSelectElement>('move-destination');
const chosenMode = () => document.querySelector<HTMLInputElement>('input[name="move-mode"]:checked')?.value;

function isSelfOrDescendant(candidate: SelectionNode, source: SelectionNode | undefined): boolean {
  if (source?.kind !== 'folder') return false;
  for (let up: SelectionNode | undefined = candidate; up; up = nodeById(up.parent)) if (up.id === source.id) return true;
  return false;
}

/** Só antecipa erros evidentes: quem decide é o motor. */
function renderOptions(): void {
  const keepSource = sourceSelect().value;
  const keepDestination = destinationSelect().value;
  const indent = (n: SelectionNode) => '  '.repeat(n.depth);
  sourceSelect().replaceChildren(...nodes().map((n) => el('option', { value: n.id, disabled: !n.canBeSource }, `${indent(n)}${label(n)}${IDENTITY_NOTE[n.identity]}`)));
  sourceSelect().value = nodes().some((n) => n.id === keepSource && n.canBeSource) ? keepSource : '';
  const source = nodeById(sourceSelect().value);
  const folders = nodes().filter((n) => n.kind === 'folder');
  destinationSelect().replaceChildren(...folders.map((n) => el('option', { value: n.id, disabled: !n.canBeDestination || isSelfOrDescendant(n, source) }, `${indent(n)}${label(n)}${IDENTITY_NOTE[n.identity]}`)));
  const destination = folders.find((n) => n.id === keepDestination);
  destinationSelect().value = destination && destination.canBeDestination && !isSelfOrDescendant(destination, source) ? keepDestination : '';
  byId('move-mode').hidden = source?.kind !== 'folder';
}

function renderCard(p: ProposalPreview): HTMLElement {
  const partial = p.group?.status === 'partially-blocked';
  return el(
    'article',
    { class: `card${p.state === 'blocked' ? ' proposal-blocked' : partial ? ' proposal-partial' : ''}`, 'data-state': p.state },
    el(
      'div',
      { class: 'card-head' },
      el('span', { class: 'card-title' }, KIND_LABEL[p.kind]),
      el('span', { class: STATE_TAG[p.state].className }, `${STATE_TAG[p.state].symbol}${STATE_LABEL[p.state]} (${p.state})`),
      ...(partial ? [el('span', { class: 'tag state-partial' }, '⚠ Parcialmente bloqueada')] : []),
      // O motor só produz `executable: false`; a tela reflete o campo, sem presumir.
      el('span', { class: 'tag' }, p.executable === false ? 'Não executável' : 'Inválida'),
      // Só o que de fato pode ser revisado; bloqueada não está aguardando revisão.
      ...(p.state === 'ready-for-review' ? [el('span', { class: 'tag' }, 'Pendente de revisão')] : []),
      ...(p.derivedPath ? [el('span', { class: 'tag' }, 'Caminho derivado')] : []),
    ),
    el('p', { class: 'refs' }, p.id),
    facts([
      ['Origem', described(p.source)],
      ['Destino', described(p.destination)],
      // A tela reflete o campo: um agrupamento nunca aparece como autorização.
      ['Agrupamento', p.group ? `${p.group.status}: ${GROUP_LABEL[p.group.status]} · ${p.group.readyOperations.length} apta(s), ${p.group.blockedOperations.length} bloqueada(s) · ${p.group.authorizesOperations === false ? 'só agrupa: não libera nenhuma operação' : 'INVÁLIDO'}` : undefined],
      ['Depende de', p.dependsOn.length ? p.dependsOn.join(', ') : undefined],
    ]),
    el('p', {}, p.justification),
    ...bullets('Conflitos', p.conflicts.map((c) => c.message)),
    ...bullets('Bloqueios', p.blockers.map((b) => b.message)),
    ...bullets('Alertas', p.alerts),
  );
}

function renderOrderItem(id: string): HTMLElement {
  const p = preview?.proposals.find((x) => x.id === id);
  return p ? el('li', {}, `${KIND_LABEL[p.kind]}: ${described(p.source)} → ${described(p.destination)} `, el('span', { class: 'muted refs-inline' }, `(${id})`)) : el('li', {}, id);
}

function renderSelectionBox(): HTMLElement {
  const from = generatedFrom!;
  const isFile = nodeById(from.source)?.kind === 'file';
  return el(
    'section',
    { id: 'move-selection', class: 'selection-box' },
    el('h3', {}, 'Seleção desta prévia'),
    facts([
      ['Inventário', from.inventory],
      ['Origem', described(from.source)],
      ['Destino', described(from.destination)],
      ['Modo', isFile ? 'não se aplica: a origem é um arquivo' : (from.mode && MODE_LABEL[from.mode]) ?? 'não informado'],
    ]),
  );
}

function renderPreview(): void {
  const result = byId('move-result');
  if (!preview) {
    result.replaceChildren();
    return;
  }
  const s = preview.summary;
  const consolidations = s.byKind['consolidate-folder'];
  const anyBlocked = s.byState.blocked > 0;
  result.replaceChildren(
    el(
      'div',
      { class: 'panel' },
      el(
        'p',
        { id: 'move-summary', class: `notice ${!preview.accepted ? 'error' : anyBlocked ? 'warn' : 'ok'}` },
        !preview.accepted
          ? 'RECUSADO: este inventário não pode gerar propostas de movimentação agora.'
          : anyBlocked
            ? `⚠ Prévia COM BLOQUEIOS: ${s.byState.blocked} bloqueada(s) · ${s.byState['ready-for-review']} apta(s) para revisão · todas NÃO EXECUTÁVEIS`
            : `Prévia: ${s.byState['ready-for-review']} apta(s) para revisão · 0 bloqueada(s) · todas NÃO EXECUTÁVEIS`,
      ),
      renderSelectionBox(),
      facts([
        ['Total de propostas', String(s.proposals)],
        ['Prontas para revisão', String(s.byState['ready-for-review'])],
        ['Bloqueadas', String(s.byState.blocked)],
        ['Consolidações', consolidations ? `${consolidations} (${Object.entries(s.consolidations).filter(([, n]) => n > 0).map(([status, n]) => `${status}: ${n}`).join(' · ')})` : '0'],
      ]),
      ...(preview.accepted ? (preview.blockingReasons.length ? bullets('Motivos de bloqueio', preview.blockingReasons) : [el('p', { class: 'muted' }, 'Motivos de bloqueio: nenhum, porque não há proposta bloqueada.')]) : []),
      ...(s.proposals === 0 ? [el('p', { class: 'muted' }, preview.accepted ? 'Nenhuma proposta foi gerada: a seleção não resultou em operações.' : 'Nenhuma proposta foi gerada: o inventário não é elegível agora. Veja os motivos abaixo e faça uma nova leitura, se preciso.')] : []),
      ...bullets('Motivos da recusa', preview.reasons),
      ...(preview.accepted ? bullets('Avisos', preview.notices) : []),
      ...(preview.safeOrder.length ? [el('h3', {}, 'Ordem segura de revisão (não é um roteiro de execução)'), el('ol', { id: 'move-order' }, ...preview.safeOrder.map(renderOrderItem))] : []),
    ),
    ...preview.proposals.map(renderCard),
  );
}

function renderInspection(): void {
  const box = byId('move-inventory');
  const picker = byId('move-picker');
  const namesButton = byId('move-names');
  if (!inspection) {
    box.replaceChildren();
    picker.hidden = true;
    namesButton.hidden = true;
    return;
  }
  box.replaceChildren(
    el('p', { class: `notice ${inspection.eligible ? 'ok' : 'error'}` }, inspection.eligibility),
    facts([
      ['Inventário', inspection.label],
      ['Data da leitura', inspection.finishedAt],
      ['Modo de leitura', inspection.readMode],
      ['Completude', inspection.completeness],
      ['Integridade', inspection.integrity],
      ['Conteúdo', inspection.counts ? `${inspection.counts.folders} pasta(s), ${inspection.counts.files} arquivo(s)` : undefined],
    ]),
    ...bullets('Motivos', inspection.reasons),
    ...(inspection.eligible ? [] : [el('p', { class: 'muted' }, 'Inventário inelegível pode ser consultado aqui, mas não gera propostas. Faça uma nova leitura ou uma retomada VERIFICADA.')]),
  );
  picker.hidden = !inspection.eligible;
  namesButton.hidden = !inspection.eligible;
  namesButton.textContent = names ? 'Ocultar nomes' : 'Revelar nomes da seleção';
  if (inspection.eligible) renderOptions();
}

/** Inventário, nomes e prévia andam juntos: trocar o inventário descarta os três. */
function reset(): void {
  epoch++;
  inspection = undefined;
  preview = undefined;
  generatedFrom = undefined;
  names = undefined;
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="move-mode"]')) radio.checked = false;
  sourceSelect().replaceChildren();
  destinationSelect().replaceChildren();
  renderInspection();
  renderPreview();
}

/** Mudou a origem, o destino ou o modo: a prévia na tela já não corresponde à seleção. */
function invalidatePreview(): void {
  epoch++;
  preview = undefined;
  generatedFrom = undefined;
  renderPreview();
}

/** Erro de um pedido antigo não aparece sobre a seleção atual. */
const unlessStale = (requested: number) => (error: SafeError) => {
  if (requested === epoch) showMessage('error', error.message);
};

export function initMovements(): void {
  const select = byId<HTMLSelectElement>('plan-select');
  select.addEventListener('change', reset);
  byId('plan-refresh').addEventListener('click', reset);

  byId('move-load').addEventListener('click', async () => {
    if (!select.value) {
      showMessage('warn', 'Escolha um inventário. Se a lista estiver vazia, grave um inventário detalhado em Leitura.');
      return;
    }
    clearMessage();
    reset();
    const requested = epoch;
    const view = await call('inspectInventory', select.value, unlessStale(requested));
    if (view && requested === epoch) {
      inspection = view;
      renderInspection();
    }
  });

  byId('move-names').addEventListener('click', async () => {
    if (names) {
      names = undefined;
      clearMessage();
    } else {
      if (!inspection) return;
      const requested = epoch;
      if (!(await confirmDialog('Revelar nomes?', REVEAL_WARNING, 'Revelar nomes')) || requested !== epoch || !inspection) return;
      const revealed = await call('revealSelectionNames', inspection.id, unlessStale(requested));
      // Revelar não muda a seleção, mas trocar de inventário durante o pedido descarta a resposta.
      if (!revealed || requested !== epoch) return;
      names = revealed;
    }
    renderInspection();
    renderPreview();
  });

  sourceSelect().addEventListener('change', () => {
    // A escolha feita para outra origem não vale para esta: nada é presumido.
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="move-mode"]')) radio.checked = false;
    renderOptions();
    invalidatePreview();
  });
  destinationSelect().addEventListener('change', invalidatePreview);
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="move-mode"]')) radio.addEventListener('change', invalidatePreview);

  byId('move-generate').addEventListener('click', async () => {
    if (!inspection) return;
    clearMessage();
    invalidatePreview();
    const requested = epoch;
    const from = { inventory: inspection.label, source: sourceSelect().value, destination: destinationSelect().value, mode: chosenMode() };
    const view = await call('previewProposals', { inventoryId: inspection.id, source: sourceSelect().value, destination: destinationSelect().value, ...(chosenMode() ? { mode: chosenMode() } : {}) }, unlessStale(requested));
    if (view && requested === epoch) {
      preview = view;
      generatedFrom = from;
      renderPreview();
    }
  });
}
