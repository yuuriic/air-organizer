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
const REVEAL_WARNING = ['A revelação pode mostrar nomes de pastas e arquivos e as justificativas registradas, que podem conter dados pessoais ou sensíveis.', 'Eles ficam visíveis nesta janela até você ocultá-los. Não compartilhe a tela sem autorização.'];
/** Texto e símbolo, além da cor: o estado não depende só da aparência. */
const STATE_TAG: Record<ProposalPreview['state'], { className: string; symbol: string }> = {
  generated: { className: 'tag', symbol: '' },
  blocked: { className: 'tag state-blocked', symbol: '⚠ ' },
  'ready-for-review': { className: 'tag state-ready', symbol: '○ ' },
};
const DECISION_TAG: Record<'approved' | 'rejected', { className: string; text: string }> = {
  approved: { className: 'tag state-approved', text: '✓ Aprovada na revisão (não autoriza execução)' },
  rejected: { className: 'tag state-rejected', text: '✕ Rejeitada na revisão' },
};
const INVALIDATED_TEXT: Record<NonNullable<ProposalPreview['decision']['invalidated']>, string> = {
  'content-changed': 'A proposta mudou depois da última decisão: aquela decisão não vale mais. Revise de novo.',
  'not-approvable': 'A aprovação registrada não vale: o motor não considera esta proposta apta agora.',
};
const IDENTITY_NOTE: Record<SelectionNode['identity'], string> = { observed: '', derived: ' · caminho derivado', unavailable: ' · sem caminho comprovável', ambiguous: ' · identidade ambígua' };

let inspection: MovementInspectionView | undefined;
let preview: MovementPreviewView | undefined;
/** A seleção que gerou a prévia exibida, guardada no pedido: não acompanha mudanças posteriores. */
let generatedFrom: { inventory: string; source: string; destination: string; mode: string | undefined } | undefined;
let names: Record<string, string> | undefined;
/** Justificativas podem conter nomes: só existem aqui enquanto os nomes estão revelados. */
let notes: Record<string, string> = {};
/** Texto ainda não enviado de cada proposta: redesenhar a prévia não apaga o que foi digitado. */
const drafts = new Map<string, string>();
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
      ...(p.decision.status === 'pending' && p.decision.approvable ? [el('span', { class: 'tag' }, 'Pendente de revisão')] : []),
      ...(p.decision.status !== 'pending' ? [el('span', { class: DECISION_TAG[p.decision.status].className }, DECISION_TAG[p.decision.status].text)] : []),
      ...(p.decision.invalidated ? [el('span', { class: 'tag state-partial' }, '⚠ Decisão anterior invalidada')] : []),
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
    renderDecision(p),
  );
}

function renderDecision(p: ProposalPreview): HTMLElement {
  const d = p.decision;
  const blocked = preview?.decisions.file === 'invalid';
  const input = el('textarea', { class: 'decision-note', rows: '2', maxlength: '500' });
  input.value = drafts.get(p.id) ?? '';
  input.addEventListener('input', () => drafts.set(p.id, input.value));
  const button = (decision: 'approved' | 'rejected', text: string) => {
    const b = el('button', { type: 'button', class: `decide-${decision}` }, text);
    b.addEventListener('click', () => void decide(p.id, decision));
    return b;
  };
  const recorded = d.status === 'pending' ? undefined : `Decisão registrada em ${d.decidedAt}.`;
  const note = !d.hasJustification ? undefined : names ? `Justificativa: ${notes[p.id] ?? '(indisponível)'}` : 'Justificativa registrada (oculta: revele os nomes para ver).';
  return el(
    'section',
    { class: 'decision', 'data-decision': d.status },
    el('h4', {}, 'Revisão humana'),
    ...(recorded ? [el('p', {}, recorded)] : []),
    ...(note ? [el('p', { class: 'decision-justification' }, note)] : []),
    ...(d.invalidated ? [el('p', { class: 'decision-invalidated' }, INVALIDATED_TEXT[d.invalidated])] : []),
    ...(d.approvalRefusal ? [el('p', { class: 'decision-refusal' }, `Aprovação não permitida: ${d.approvalRefusal}`)] : []),
    ...(p.kind === 'consolidate-folder' ? [el('p', { class: 'muted decision-independence' }, 'Aprovar esta consolidação não aprova as operações dela, e rejeitá-la não muda as decisões delas. Nada disso autoriza execução.')] : []),
    ...(p.parentOperation ? [el('p', { class: 'muted decision-independence' }, 'Aprovar esta operação não aprova a consolidação dela. Mesmo com a consolidação rejeitada, esta decisão continua separada e não autoriza execução.')] : []),
    ...(d.history > 1 ? [el('p', { class: 'muted' }, `${d.history} registros no histórico desta proposta.`)] : []),
    ...(blocked
      ? [el('p', { class: 'decision-blocked' }, 'Novas decisões bloqueadas: o histórico local deste inventário é inválido.')]
      : [el('label', { class: 'field' }, 'Justificativa (opcional; evite nomes de pessoas e documentos)', input), el('div', { class: 'actions' }, ...(d.approvable ? [button('approved', 'Aprovar')] : []), button('rejected', 'Rejeitar'))]),
  );
}

/** A decisão vale só para a prévia exibida; resposta depois de mudar a seleção é descartada. */
async function decide(proposalId: string, decision: 'approved' | 'rejected'): Promise<void> {
  if (!inspection || !generatedFrom) return;
  clearMessage();
  const requested = epoch;
  const inventoryId = inspection.id;
  const buttons = () => document.querySelectorAll<HTMLButtonElement>('#move-result .decision button');
  for (const b of buttons()) b.disabled = true;
  const { source, destination, mode } = generatedFrom;
  const justification = drafts.get(proposalId)?.trim();
  const view = await call('decideProposal', { selection: { inventoryId, source, destination, ...(mode ? { mode } : {}) }, proposalId, decision, ...(justification ? { justification } : {}) }, unlessStale(requested));
  if (requested !== epoch) return;
  if (!view) {
    for (const b of buttons()) b.disabled = false;
    return;
  }
  preview = view;
  drafts.delete(proposalId);
  if (names) {
    const refreshed = await call('revealDecisionNotes', inventoryId, unlessStale(requested));
    if (requested !== epoch) return;
    if (refreshed) notes = refreshed;
  }
  renderPreview();
  showMessage('ok', decision === 'approved' ? 'Aprovação registrada localmente. Nada foi executado no AIR.' : 'Rejeição registrada localmente. Nada foi executado no AIR.');
}

/** A confirmação é do processo principal: aqui só se pede o início e se redesenha com o resultado. */
async function resetHistory(): Promise<void> {
  if (!inspection || !generatedFrom) return;
  clearMessage();
  const requested = epoch;
  const inventoryId = inspection.id;
  const { source, destination, mode } = generatedFrom;
  const result = await call('resetDecisionHistory', inventoryId, unlessStale(requested));
  if (!result || requested !== epoch) return;
  if (result.outcome === 'cancelled') {
    showMessage('warn', 'Nada foi alterado: o histórico inválido continua guardado, e as decisões seguem bloqueadas.');
    return;
  }
  const view = await call('previewProposals', { inventoryId, source, destination, ...(mode ? { mode } : {}) }, unlessStale(requested));
  if (!view || requested !== epoch) return;
  preview = view;
  notes = {};
  renderPreview();
  showMessage('ok', 'Novo histórico iniciado, vazio. O anterior foi guardado como cópia de recuperação, e as decisões dele não foram importadas.');
}

function renderDecisionSummary(): HTMLElement[] {
  const d = preview!.decisions;
  const resetButton = el('button', { id: 'move-history-reset', type: 'button' }, 'Iniciar novo histórico');
  resetButton.addEventListener('click', () => void resetHistory());
  return [
    el('p', { id: 'move-decisions' }, `Revisão humana: ${d.approved} aprovada(s) · ${d.rejected} rejeitada(s) · ${d.pending} pendente(s) · ${d.notApprovable} sem aprovação possível`),
    ...(d.invalidated ? [el('p', { class: 'notice warn' }, `⚠ ${d.invalidated} decisão(ões) anterior(es) invalidada(s): a proposta mudou ou não está apta. Revise de novo.`)] : []),
    ...(d.file === 'invalid' ? [el('p', { id: 'move-decisions-invalid', class: 'notice error' }, 'O histórico local de decisões deste inventário não pôde ser validado e foi ignorado: nenhuma decisão anterior foi aproveitada, e novas decisões estão bloqueadas. O arquivo foi preservado. Para continuar, inicie um novo histórico: o atual será guardado como cópia de recuperação, sem importar nada dele.'), el('div', { class: 'actions' }, resetButton)] : []),
    el('p', { class: 'muted' }, 'Decisões ficam só neste computador e registram apenas a revisão: não executam nem autorizam nada no AIR.'),
    el('p', { id: 'move-decisions-independence', class: 'muted' }, 'Consolidações e operações são revisadas de forma independente: aprovar uma não aprova a outra, e uma consolidação rejeitada pode ter operações aprovadas. Uma etapa futura de execução terá de validar a consistência entre elas antes de qualquer movimentação.'),
  ];
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
      ...(preview.accepted ? renderDecisionSummary() : []),
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
  notes = {};
  drafts.clear();
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
  drafts.clear();
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
      notes = {};
      clearMessage();
    } else {
      if (!inspection) return;
      const requested = epoch;
      if (!(await confirmDialog('Revelar nomes?', REVEAL_WARNING, 'Revelar nomes')) || requested !== epoch || !inspection) return;
      const revealed = await call('revealSelectionNames', inspection.id, unlessStale(requested));
      // Revelar não muda a seleção, mas trocar de inventário durante o pedido descarta a resposta.
      if (!revealed || requested !== epoch) return;
      const revealedNotes = await call('revealDecisionNotes', inspection.id, unlessStale(requested));
      if (!revealedNotes || requested !== epoch) return;
      names = revealed;
      notes = revealedNotes;
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
