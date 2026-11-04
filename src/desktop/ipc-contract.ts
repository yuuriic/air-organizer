import type { AppController, AppEvent, SafeError } from '../app/controller.js';

/** Únicas operações que a janela pode pedir. Não há canal genérico, acesso a arquivos nem ação de escrita no AIR. */
export const API_METHODS = [
  'status',
  'openChrome',
  'closeChrome',
  'forceCloseChrome',
  'listTabs',
  'selectTab',
  'checkConnection',
  'readCurrentFolder',
  'listSubfolders',
  'readSubfolder',
  'revealDuplicates',
  'exportFolder',
  'startTree',
  'stopOperation',
  'exportTreeDetailed',
  'listResumable',
  'resumeTree',
  'listInventories',
  'diagnose',
  'revealDiagnosticNames',
  'exportDiagnosticDetailed',
  'plan',
  'revealPlanNames',
  'exportPlanDetailed',
  'getSettings',
  'saveSettings',
] as const;

export type ApiMethod = (typeof API_METHODS)[number];

export const apiChannel = (method: ApiMethod) => `api:${method}`;
export const EVENT_CHANNEL = 'app:event';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: SafeError };

/** API exposta à janela pelo preload, como `window.airOrganizer`. Erros chegam só em forma segura. */
export type DesktopApi = {
  [K in ApiMethod]: (arg?: unknown) => Promise<ApiResult<Awaited<ReturnType<AppController[K]>>>>;
} & {
  /** Devolve a função que cancela a inscrição. */
  onEvent(listener: (event: AppEvent) => void): () => void;
};

/** Só a página principal do próprio aplicativo pode chamar o processo principal. */
export function isTrustedSender(frameUrl: string | undefined, isMainFrame: boolean, appUrl: string): boolean {
  return isMainFrame && frameUrl === appUrl;
}
