import type { AppEvent, AppStatus, OperationKind } from '../../app/controller.js';
import type { ChromeFailure, ChromeStatus } from '../../app/connection.js';
import { initAnalysis, refreshInventories } from './analysis.js';
import { api, byId, call, clearMessage, confirmDialog, el, showMessage } from './dom.js';
import { initMovements } from './movements.js';
import { initRead, operatorInput } from './read.js';
import { initSettings } from './settings.js';

const CHROME_LABEL: Record<ChromeStatus['state'], string> = { closed: 'Fechado', opening: 'Abrindo...', open: 'Aberto', closing: 'Fechando...' };
const AIR_LABEL: Record<AppStatus['air'], string> = { 'not-verified': 'Não verificada', 'listing-found': 'Listagem do AIR detectada', 'listing-not-found': 'Listagem do AIR não encontrada nesta aba' };
const OPERATION_LABEL: Record<OperationKind, string> = {
  connection: 'Verificando a conexão',
  folder: 'Lendo a pasta atual',
  subfolder: 'Lendo a subpasta',
  tree: 'Lendo a árvore',
  resume: 'Retomada em andamento',
  diagnostics: 'Diagnosticando',
  planning: 'Gerando propostas',
};
const FAILURE_MESSAGE: Record<ChromeFailure, string> = {
  'profile-in-use': 'O perfil dedicado já está em uso, possivelmente por outra janela ou pela CLI. Feche-a e tente de novo.',
  'chrome-not-found': 'O Google Chrome não foi encontrado neste computador.',
  'profile-not-allowed': 'O diretório configurado para o perfil não é permitido. Use um diretório dedicado, fora do repositório.',
  'launch-failed': 'Não foi possível abrir o Chrome dedicado. Tente de novo.',
};

let current: AppStatus | undefined;
let lastFailure: ChromeFailure | undefined;

/** Botão só fica habilitado quando a ação pode executar de verdade agora. */
function refreshButtons(): void {
  if (!current) return;
  const idle = !current.operation;
  const chromeOpen = current.chrome.state === 'open';
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-needs]')) {
    const needs = button.dataset.needs;
    const noInventory = button.dataset.noInventory === 'true';
    button.disabled = !idle || noInventory || (needs === 'chrome' && !chromeOpen) || (needs === 'stopped' && current.chrome.state !== 'closed');
  }
  byId<HTMLButtonElement>('open-chrome').disabled = current.chrome.state !== 'closed';
  byId<HTMLButtonElement>('close-chrome').disabled = !chromeOpen || !idle;
}

function render(status: AppStatus): void {
  const wasOpen = current?.chrome.state === 'open';
  current = status;
  byId('chrome-state').textContent = CHROME_LABEL[status.chrome.state];
  byId('air-state').textContent = AIR_LABEL[status.air];
  if (status.chrome.state === 'closed') {
    byId('tab-field').hidden = true;
    byId('connection-result').replaceChildren();
  }
  if (status.chrome.failure && status.chrome.failure !== lastFailure) showMessage('error', FAILURE_MESSAGE[status.chrome.failure]);
  lastFailure = status.chrome.failure;
  if (wasOpen && status.chrome.state === 'closed' && status.operation) showMessage('warn', 'O Chrome dedicado foi fechado durante a operação. O checkpoint gravado foi preservado.');

  const op = status.operation;
  const bar = byId('op-bar');
  bar.hidden = !op;
  if (op) {
    byId('op-title').textContent = op.stopping ? 'Parando: conclui a página em leitura, não abre mais nada e volta à pasta inicial...' : OPERATION_LABEL[op.kind];
    const p = op.progress;
    byId('op-progress').textContent = p ? `Pastas ${p.foldersRead} · itens ${p.items} · páginas ${p.pages} · pendências ${p.pending}` : '';
    const stop = byId<HTMLButtonElement>('op-stop');
    stop.hidden = !op.stoppable;
    stop.disabled = op.stopping;
    byId('op-force').hidden = !op.stopping;
  }
  refreshButtons();
}

function onEvent(event: AppEvent): void {
  if (event.type === 'status') {
    render(event.status);
    return;
  }
  if (event.type === 'warning') {
    showMessage('warn', event.text);
    return;
  }
  const log = byId('op-log');
  log.textContent = `${log.textContent ?? ''}${event.line}\n`;
  const lines = log.textContent.split('\n');
  if (lines.length > 500) log.textContent = lines.slice(-500).join('\n');
}

async function refreshTabs(): Promise<void> {
  const view = await call('listTabs');
  if (!view) return;
  const select = byId<HTMLSelectElement>('tab-select');
  select.replaceChildren(
    ...(view.selected < 0 ? [el('option', { value: '' }, 'Escolha a aba do AIR')] : []),
    ...view.tabs.map((title, i) => el('option', { value: String(i), selected: i === view.selected }, title || '(sem título)')),
  );
  byId('tab-field').hidden = view.tabs.length < 2;
}

for (const button of document.querySelectorAll<HTMLButtonElement>('button.nav')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll<HTMLButtonElement>('button.nav')) other.removeAttribute('aria-current');
    button.setAttribute('aria-current', 'page');
    for (const screen of document.querySelectorAll<HTMLElement>('.screen')) screen.hidden = screen.id !== button.dataset.screen;
    if (button.dataset.screen === 'diagnostics' || button.dataset.screen === 'planning') refreshInventories();
  });
}

byId('open-chrome').addEventListener('click', () => {
  clearMessage();
  void call('openChrome');
});
byId('close-chrome').addEventListener('click', () => void call('closeChrome'));
byId('op-stop').addEventListener('click', () => void call('stopOperation'));
byId('op-force').addEventListener('click', async () => {
  const ok = await confirmDialog('Fechar o Chrome à força?', ['Use só se a leitura não terminar depois de pedir a parada.', 'O estado da navegação fica incerto e a leitura fica interrompida. O checkpoint gravado é preservado para retomada.'], 'Fechar à força');
  if (ok) void call('forceCloseChrome');
});
byId('check-connection').addEventListener('click', async () => {
  clearMessage();
  await refreshTabs();
  const view = await call('checkConnection', operatorInput());
  if (!view) return;
  byId('connection-result').replaceChildren(
    el('dl', { class: 'kv' }, ...view.fields.flatMap((field) => [el('dt', {}, field.label), el('dd', {}, field.detail)]), el('dt', {}, 'Paginação'), el('dd', {}, view.paging)),
    el('ul', { class: 'lines' }, ...view.listing.map((line) => el('li', {}, line))),
  );
});
byId('tab-select').addEventListener('change', (event) => {
  const { value } = event.target as HTMLSelectElement;
  if (value === '') return;
  clearMessage();
  byId('connection-result').replaceChildren();
  void call('selectTab', Number(value));
});
document.addEventListener('air-buttons-changed', refreshButtons);

api.onEvent(onEvent);
initRead();
initAnalysis();
initMovements();
initSettings();
void call('status').then((status) => status && render(status));
