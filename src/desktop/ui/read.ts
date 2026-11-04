import type { FolderView, TreeRunView } from '../../app/controller.js';
import type { TreeLimits } from '../../types/inventory.js';
import { byId, call, clearMessage, confirmDialog, detailedExportButton, el, namesButton, showMessage, writtenList } from './dom.js';

const CONSERVATIVE: TreeLimits = { maxDepth: 1, maxFolders: 5, maxItems: 100, maxPagesPerFolder: 2 };
const WIDE: TreeLimits = { maxDepth: 50, maxFolders: 10_000, maxItems: 1_000_000, maxPagesPerFolder: 500 };
const LIMIT_FIELDS: Array<[keyof TreeLimits, string, number]> = [
  ['maxDepth', 'Profundidade máxima', 0],
  ['maxFolders', 'Pastas a ler', 1],
  ['maxItems', 'Itens a ler', 1],
  ['maxPagesPerFolder', 'Páginas por pasta', 1],
];

const describe = (l: TreeLimits) => `profundidade ${l.maxDepth}, ${l.maxFolders} pasta(s), ${l.maxItems} itens, ${l.maxPagesPerFolder} página(s) por pasta`;

export const operatorInput = () => ({ client: byId<HTMLInputElement>('op-client').value, sector: byId<HTMLInputElement>('op-sector').value });

/** Campos de limite; `read` devolve undefined se algum for inválido. */
function limitFields(container: HTMLElement, initial: TreeLimits, prefix: string) {
  const inputs = new Map<keyof TreeLimits, HTMLInputElement>();
  container.replaceChildren(
    ...LIMIT_FIELDS.map(([key, label, min]) => {
      const input = el('input', { id: `${prefix}-${key}`, type: 'number', min: String(min), step: '1', value: String(initial[key]) });
      inputs.set(key, input);
      return el('label', { class: 'field' }, label, input);
    }),
  );
  return {
    set: (values: TreeLimits) => inputs.forEach((input, key) => (input.value = String(values[key]))),
    read: (): TreeLimits | undefined => {
      const values = {} as TreeLimits;
      for (const [key, label, min] of LIMIT_FIELDS) {
        const n = Number(inputs.get(key)!.value);
        if (!Number.isSafeInteger(n) || n < min || inputs.get(key)!.value.trim() === '') {
          showMessage('error', `${label}: informe um inteiro >= ${min}.`);
          return undefined;
        }
        values[key] = n;
      }
      return values;
    },
  };
}

function renderFolder(view: FolderView): void {
  const names = el('div');
  const actions = el('div', { class: 'actions' }, detailedExportButton('Gravar inventário detalhado', 'exportFolder', { detailed: true }));
  const save = el('button', { type: 'button' }, 'Gravar relatório sem nomes');
  save.addEventListener('click', async () => {
    const files = await call('exportFolder', { detailed: false });
    if (files) showMessage('ok', `Gravado: ${files.join(' · ')}`);
  });
  actions.prepend(save);
  if (view.duplicates.length) actions.append(namesButton('revealDuplicates', names));
  byId('folder-result').replaceChildren(
    el('p', { class: `notice ${view.outcome === 'complete' ? 'ok' : 'warn'}` }, view.outcome === 'complete' ? 'Leitura COMPLETA.' : 'Leitura PARCIAL: nem tudo foi lido.'),
    el('ul', { class: 'lines' }, ...view.lines.map((line) => el('li', {}, line))),
    el('h3', {}, `Suspeitas de duplicidade por nome: ${view.duplicates.length} (não comprovam conteúdo igual)`),
    el('ul', { class: 'lines' }, ...view.duplicates.map((d) => el('li', {}, `${d.ref} [${d.confidence}] ${d.items} itens · regras: ${d.rules}`))),
    actions,
    names,
  );
}

function renderTree(container: HTMLElement, view: TreeRunView): void {
  const headline = view.stopped ? 'INTERROMPIDA a seu pedido: leitura PARCIAL, com checkpoint preservado para retomada.' : `Resultado: ${view.statusLabel}${view.eligible ? ' · pode fundamentar planejamento, se gravado o inventário detalhado.' : ''}`;
  container.replaceChildren(
    el('p', { class: `notice ${view.status === 'complete' ? 'ok' : view.status === 'partial' ? 'warn' : 'error'}` }, headline),
    el('ul', { class: 'lines' }, ...view.lines.map((line) => el('li', {}, line))),
    view.exportFailed ? el('p', { class: 'warning' }, 'O relatório sem nomes não pôde ser gravado; o checkpoint foi preservado.') : writtenList(view.written),
    el('p', { class: 'muted' }, 'O inventário detalhado é o que alimenta Diagnóstico e Planejamento. Ele contém nomes e caminhos, e só é gravado se você pedir.'),
    el('div', { class: 'actions' }, detailedExportButton('Gravar inventário detalhado', 'exportTreeDetailed')),
  );
}

export function initRead(): void {
  const treeLimits = limitFields(byId('tree-limits'), CONSERVATIVE, 'tree');
  byId('wide-limits').addEventListener('click', () => treeLimits.set(WIDE));

  byId('read-folder').addEventListener('click', async () => {
    if (!(await confirmDialog('Analisar a pasta atual?', ['Somente leitura, sem entrar em subpastas. A análise vale para a pasta exibida agora no Chrome dedicado: confira se é a pasta autorizada.'], 'Analisar'))) return;
    clearMessage();
    const view = await call('readCurrentFolder', operatorInput());
    if (view) renderFolder(view);
  });

  byId('list-subfolders').addEventListener('click', async () => {
    clearMessage();
    const list = await call('listSubfolders');
    if (!list) return;
    if (list.items.length === 0) {
      byId('subfolder-list').hidden = true;
      showMessage('warn', 'Nenhuma subpasta identificada com segurança nesta página.');
      return;
    }
    byId('subfolder-select').replaceChildren(...list.items.map((item) => el('option', { value: String(item.id) }, item.name)));
    byId('subfolder-list').hidden = false;
  });

  byId('read-subfolder').addEventListener('click', async () => {
    const select = byId<HTMLSelectElement>('subfolder-select');
    const name = select.selectedOptions[0]?.textContent ?? '';
    if (!(await confirmDialog('Abrir a subpasta?', [`"${name}"`, 'Somente leitura: abre, confirma a identidade, lê e volta à pasta anterior.'], 'Abrir e ler'))) return;
    clearMessage();
    byId('subfolder-list').hidden = true;
    const view = await call('readSubfolder', { id: Number(select.value), operator: operatorInput() });
    if (view) renderFolder(view);
  });

  byId('start-tree').addEventListener('click', async () => {
    const limits = treeLimits.read();
    if (!limits) return;
    const ok = await confirmDialog(
      'Iniciar a leitura recursiva?',
      [
        'Pasta inicial: a exibida agora no Chrome dedicado. Confira se é a autorizada.',
        `Limites: ${describe(limits)}. Ao atingir um limite, a leitura para e fica PARCIAL.`,
        'Cliques: só próxima página / número da página, nome de subpasta (nunca arquivo) e voltar.',
        'Checkpoint: gravado no seu perfil local, pseudonimizado (sem nomes, caminhos nem URLs).',
      ],
      'Iniciar leitura',
    );
    if (!ok) return;
    clearMessage();
    byId('op-log').textContent = '';
    byId('tree-result').replaceChildren();
    const view = await call('startTree', { limits, operator: operatorInput() });
    if (view) renderTree(byId('tree-result'), view);
  });

  byId('list-resumable').addEventListener('click', async () => {
    clearMessage();
    const list = await call('listResumable', operatorInput());
    if (!list) return;
    const container = byId('resume-result');
    const notes = [
      ...(list.expired ? [el('p', { class: 'muted' }, `${list.expired} checkpoint(s) fora do prazo de retenção: não podem ser retomados. A limpeza é feita pela CLI.`)] : []),
      ...list.unavailable.map((u) => el('p', { class: 'muted' }, `${u.runId}: ${u.message}`)),
    ];
    if (list.runs.length === 0) {
      container.replaceChildren(
        el('p', { class: 'notice warn' }, list.mismatched.length ? 'Nenhuma execução gravada corresponde à instância, cliente, setor e pasta exibidos.' : 'Nenhum checkpoint válido para retomar.'),
        ...list.mismatched.map((m) => el('p', { class: 'muted' }, `${m.runId}: ${m.message}`)),
        ...notes,
      );
      return;
    }
    const limitsBox = el('div', { class: 'fields limits' });
    const limits = limitFields(limitsBox, list.runs[0]!.limits, 'resume');
    const options = list.runs.map((run, i) => {
      const radio = el('input', { type: 'radio', name: 'resume-run', value: run.id, checked: i === 0 });
      radio.addEventListener('change', () => limits.set(run.limits));
      return el(
        'label',
        { class: 'run' },
        radio,
        el('span', {}, `${run.id} · ${run.state} · atualizada em ${run.updatedAt} · ${run.folders} pasta(s), ${run.items} itens, ${run.pages} página(s) · pendências ${run.pending}. Limites anteriores: ${run.limitsText}${run.limitsReached.length ? ` (atingidos: ${run.limitsReached.join(', ')})` : ''}`),
      );
    });
    const mode = el(
      'select',
      { id: 'resume-mode' },
      el('option', { value: 'verified' }, 'VERIFICADA (recomendada): relê todo o escopo; resultado completo pode fundamentar planejamento'),
      el('option', { value: 'fast' }, 'RÁPIDA: não reabre subpastas concluídas; NÃO serve para planejar movimentações'),
    );
    const start = el('button', { id: 'start-resume', class: 'primary', 'data-needs': 'chrome' }, 'Retomar');
    const result = el('div');
    start.addEventListener('click', async () => {
      const chosen = container.querySelector<HTMLInputElement>('input[name="resume-run"]:checked');
      const chosenLimits = limits.read();
      if (!chosen || !chosenLimits) return;
      const verified = mode.value === 'verified';
      const ok = await confirmDialog(
        `Retomar em modo ${verified ? 'VERIFICADO' : 'RÁPIDO'}?`,
        [
          verified ? 'Toda pasta do escopo é reaberta e relida; nada é reaproveitado sem releitura.' : 'Pastas com pendência são relidas; subpastas concluídas com linha idêntica no pai são reaproveitadas SEM revalidar o conteúdo.',
          `Limites: ${describe(chosenLimits)}.`,
          'Uma execução parcial só fica completa se o que faltava for de fato lido nesta sessão.',
        ],
        'Retomar',
      );
      if (!ok) return;
      clearMessage();
      byId('op-log').textContent = '';
      const view = await call('resumeTree', { id: chosen.value, mode: mode.value, limits: chosenLimits, operator: operatorInput() });
      if (view) {
        for (const option of options) option.remove();
        renderTree(result, view);
      }
    });
    container.replaceChildren(
      ...options,
      el('label', { class: 'field' }, 'Modo de retomada', mode),
      el('h3', {}, 'Limites da execução inteira (nunca são aumentados automaticamente)'),
      limitsBox,
      el('div', { class: 'row' }, start),
      ...notes,
      result,
    );
    document.dispatchEvent(new Event('air-buttons-changed'));
  });
}
