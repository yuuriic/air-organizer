import type { NamesView, SafeError } from '../../app/controller.js';
import type { ApiMethod, ApiResult, DesktopApi } from '../ipc-contract.js';

declare global {
  interface Window {
    airOrganizer: DesktopApi;
  }
}

export const api = window.airOrganizer;
export const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Props = { class?: string; hidden?: boolean; [attribute: string]: string | boolean | undefined };

/** Texto vindo do AIR é sempre dado: nunca interpretado como HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children);
  return node;
}

export function showMessage(kind: 'ok' | 'error' | 'warn', text: string): void {
  const message = byId('message');
  message.className = `message ${kind}`;
  message.textContent = text;
  message.hidden = false;
}

export function clearMessage(): void {
  byId('message').hidden = true;
}

type Data<K extends ApiMethod> = Awaited<ReturnType<DesktopApi[K]>> extends ApiResult<infer T> ? T : never;

/** Chama o processo principal; falhas viram mensagem na tela e `undefined`. */
export async function call<K extends ApiMethod>(method: K, arg?: unknown, onError?: (error: SafeError) => void): Promise<Data<K> | undefined> {
  const result = await api[method](arg).catch(() => ({ ok: false as const, error: { code: 'unexpected', message: 'A operação falhou de forma inesperada.' } }));
  if (result.ok) return result.data as Data<K>;
  (onError ?? ((error: SafeError) => showMessage('error', error.message)))(result.error);
  return undefined;
}

/** Confirmação explícita, com o escopo por escrito. O padrão é cancelar. */
export function confirmDialog(title: string, lines: string[], yes: string): Promise<boolean> {
  const dialog = byId<HTMLDialogElement>('confirm');
  byId('confirm-title').textContent = title;
  byId('confirm-body').replaceChildren(...lines.map((line) => el('p', {}, line)));
  byId('confirm-yes').textContent = yes;
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      byId('confirm-yes').removeEventListener('click', accept);
      byId('confirm-no').removeEventListener('click', refuse);
      dialog.removeEventListener('cancel', refuse);
      dialog.close();
      resolve(value);
    };
    const accept = () => finish(true);
    const refuse = () => finish(false);
    byId('confirm-yes').addEventListener('click', accept);
    byId('confirm-no').addEventListener('click', refuse);
    dialog.addEventListener('cancel', refuse);
    dialog.showModal();
    byId('confirm-no').focus();
  });
}

const NAMES_WARNING = ['Os nomes das pastas podem conter dados pessoais ou sensíveis.', 'Eles ficam visíveis nesta janela. Não compartilhe a tela sem autorização.'];

/** Botão que só mostra nomes depois de confirmação. */
export function namesButton(method: 'revealDuplicates' | 'revealDiagnosticNames' | 'revealPlanNames', container: HTMLElement): HTMLButtonElement {
  const button = el('button', { type: 'button' }, 'Mostrar nomes');
  button.addEventListener('click', async () => {
    if (!(await confirmDialog('Mostrar nomes?', NAMES_WARNING, 'Mostrar nomes'))) return;
    const names = await call(method);
    if (names) {
      container.replaceChildren(renderNames(names));
      button.disabled = true;
    }
  });
  return button;
}

function renderNames(groups: NamesView): HTMLElement {
  return el(
    'div',
    { class: 'names' },
    ...groups.flatMap((group) => [
      el('h3', {}, `${group.id} · ${group.title}`),
      el('ul', {}, ...group.folders.map((folder) => el('li', {}, `${folder.ref}: ${folder.label}`)), ...group.details.map((detail) => el('li', {}, detail))),
    ]),
  );
}

/** Lista de arquivos gravados (caminhos já com instância e setor omitidos). */
export const writtenList = (files: string[]) => (files.length ? el('p', { class: 'muted' }, `Gravado: ${files.join(' · ')}`) : el('span'));

/** Botão de gravação de arquivo com nomes: sempre pede confirmação. */
export function detailedExportButton(label: string, method: 'exportTreeDetailed' | 'exportDiagnosticDetailed' | 'exportPlanDetailed' | 'exportFolder', arg?: unknown): HTMLButtonElement {
  const button = el('button', { type: 'button' }, label);
  button.addEventListener('click', async () => {
    if (!(await confirmDialog(label, ['O arquivo contém nomes e caminhos, possivelmente dados pessoais ou sensíveis.', 'Grave somente se permitido pelas políticas da organização. Ele fica só neste computador, fora do Git.'], 'Gravar'))) return;
    const files = await call(method, arg);
    if (files) showMessage('ok', `Gravado: ${files.join(' · ')}`);
  });
  return button;
}
