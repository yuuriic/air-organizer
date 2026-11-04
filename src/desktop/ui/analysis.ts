import type { DiagnosticView, PlanView } from '../../app/controller.js';
import type { PlanProposal } from '../../core/organization-planner.js';
import { byId, call, clearMessage, detailedExportButton, el, namesButton, showMessage, writtenList } from './dom.js';

const CERTAINTY_LABEL: Record<string, string> = { exact: 'nomes idênticos', normalized: 'equivalentes por normalização', structural: 'padrão de estrutura' };
const KIND_LABEL: Record<PlanProposal['kind'], string> = {
  'review-equivalent-names': 'Nomes equivalentes',
  'review-naming-inconsistency': 'Nomenclatura',
  'review-standardization': 'Padronização',
  'review-divergent-hierarchy': 'Hierarquia',
};
const CONFIDENCE_LABEL = { high: 'alta', medium: 'média', low: 'baixa' } as const;

const facts = (entries: Array<[string, string | undefined]>) =>
  el('dl', { class: 'kv' }, ...entries.flatMap(([label, value]) => (value === undefined ? [] : [el('dt', {}, label), el('dd', {}, value)])));
const bullets = (title: string, items: string[]) => (items.length ? [el('h3', {}, title), el('ul', {}, ...items.map((item) => el('li', {}, item)))] : []);

async function loadInventories(selectId: string, run: HTMLElement): Promise<void> {
  const list = await call('listInventories');
  if (!list) return;
  const select = byId<HTMLSelectElement>(selectId);
  select.replaceChildren(...list.map((inv) => el('option', { value: inv.id }, `${inv.label} · ${inv.status} · finalizado em ${inv.finishedAt}`)));
  run.dataset.noInventory = list.length === 0 ? 'true' : 'false';
  if (list.length === 0) select.append(el('option', { value: '' }, 'Nenhum inventário detalhado gravado. Grave um em Leitura.'));
  document.dispatchEvent(new Event('air-buttons-changed'));
}

function renderDiagnostic(view: DiagnosticView): void {
  const names = el('div');
  const c = view.coverage;
  const s = view.summary;
  const rejected = view.eligibilityStatus === 'rejected';
  byId('diag-result').replaceChildren(
    el(
      'div',
      { class: 'panel' },
      el('p', { class: `notice ${view.eligibilityStatus === 'planning-eligible' ? 'ok' : rejected ? 'error' : 'warn'}` }, view.eligibility),
      facts([
        ['Integridade', view.integrity],
        ['Completude', view.completeness],
        ['Cobertura', c ? `${c.folders} pasta(s); ${c.foldersWithName} com nome; ${c.foldersRead} lida(s); ${c.foldersComplete} com listagem completa` : undefined],
        ['Achados', s ? `${s.findings} (duplicidade possível ${s.byCategory['possible-duplicate']} · nomenclatura ${s.byCategory['inconsistent-naming']} · hierarquia ${s.byCategory['divergent-hierarchy']})` : undefined],
      ]),
      ...bullets('Motivos', view.reasons),
      rejected ? el('span') : el('p', { class: 'muted' }, 'Todo achado exige revisão humana. Nenhum renomear, mover ou mesclar é sugerido.'),
      writtenList(view.written),
      rejected ? el('span') : el('div', { class: 'actions' }, ...(view.hasNames ? [namesButton('revealDiagnosticNames', names)] : []), detailedExportButton('Gravar relatório detalhado', 'exportDiagnosticDetailed')),
      names,
    ),
    ...view.findings.map((f) =>
      el(
        'article',
        { class: 'card' },
        el('div', { class: 'card-head' }, el('span', { class: 'card-title' }, f.rule), el('span', { class: 'tag' }, CERTAINTY_LABEL[f.certainty] ?? f.certainty), el('span', { class: 'tag' }, 'Revisão humana')),
        el('p', { class: 'refs' }, f.line),
        ...bullets('Limitações', f.limitations),
      ),
    ),
  );
}

function renderProposal(p: PlanProposal): HTMLElement {
  return el(
    'article',
    { class: 'card', 'data-kind': p.kind },
    el(
      'div',
      { class: 'card-head' },
      el('span', { class: 'card-title' }, p.proposal.summary),
      el('span', { class: 'tag' }, KIND_LABEL[p.kind]),
      el('span', { class: 'tag' }, `Evidência ${CONFIDENCE_LABEL[p.confidence.level]}`),
      el('span', { class: 'tag' }, 'Pendente de revisão'),
      // O motor só produz `executable: false`; a tela reflete o campo, sem presumir.
      el('span', { class: 'tag' }, p.executable === false ? 'Não executável' : 'Inválida'),
    ),
    el('p', { class: 'refs' }, `${p.id} · pastas: ${p.observed.folders.map((f) => f.ref).join(', ')}`),
    el('p', {}, p.proposal.justification),
    el('p', { class: 'muted' }, `Critério da evidência: ${p.confidence.basis}`),
    ...bullets('Perguntas para o revisor', p.proposal.reviewQuestions),
    ...bullets('Impedimentos', p.blockers),
    ...bullets('Riscos', p.risks),
    ...(p.futureAction ? [el('h3', {}, 'Hipótese para revisão futura (não é uma ação)'), el('p', {}, p.futureAction.hypothesis), ...bullets('Condições antes de qualquer ação', p.futureAction.preconditions)] : []),
  );
}

function renderPlan(view: PlanView): void {
  const names = el('div');
  const s = view.summary;
  byId('plan-result').replaceChildren(
    el(
      'div',
      { class: 'panel' },
      el(
        'p',
        { class: `notice ${view.accepted ? 'ok' : 'error'}` },
        view.accepted ? `${s.proposals} proposta(s) de revisão, todas PENDENTES e NÃO EXECUTÁVEIS · ${s.withFutureAction} com hipótese futura · ${s.withBlockers} com impedimentos` : 'RECUSADO: só inventário autenticado, completo, revalidado e recente gera propostas. Nenhuma proposta foi gerada.',
      ),
      facts([
        ['Integridade', view.integrity],
        ['Completude', view.completeness],
        ['Por tipo', view.accepted ? `nomes equivalentes ${s.byKind['review-equivalent-names']} · nomenclatura ${s.byKind['review-naming-inconsistency']} · padronização ${s.byKind['review-standardization']} · hierarquia ${s.byKind['review-divergent-hierarchy']}` : undefined],
      ]),
      ...bullets('Motivos da recusa', view.reasons),
      ...(view.accepted ? bullets('Avisos', view.notices) : [el('p', { class: 'muted' }, 'Para explorar os achados mesmo assim, use Diagnóstico. Para planejar, faça uma nova leitura ou uma retomada VERIFICADA e grave o inventário detalhado.')]),
      writtenList(view.written),
      view.accepted ? el('div', { class: 'actions' }, ...(view.hasNames ? [namesButton('revealPlanNames', names)] : []), detailedExportButton('Gravar plano detalhado', 'exportPlanDetailed')) : el('span'),
      names,
    ),
    ...view.proposals.map(renderProposal),
  );
}

export function initAnalysis(): void {
  const wire = <T>(prefix: string, method: 'diagnose' | 'plan', render: (view: T) => void) => {
    const select = byId<HTMLSelectElement>(`${prefix}-select`);
    const run = byId(`${prefix}-run`);
    byId(`${prefix}-refresh`).addEventListener('click', () => void loadInventories(`${prefix}-select`, run));
    run.addEventListener('click', async () => {
      if (!select.value) {
        showMessage('warn', 'Escolha um inventário. Se a lista estiver vazia, grave um inventário detalhado em Leitura.');
        return;
      }
      clearMessage();
      const view = await call(method, select.value);
      if (view) render(view as T);
    });
    void loadInventories(`${prefix}-select`, run);
  };
  wire<DiagnosticView>('diag', 'diagnose', renderDiagnostic);
  wire<PlanView>('plan', 'plan', renderPlan);
}

export function refreshInventories(): void {
  byId('diag-refresh').click();
  byId('plan-refresh').click();
}
