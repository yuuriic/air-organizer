import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, Menu, app, dialog, ipcMain, session } from 'electron';
import type { BrowserContext } from 'playwright';
import { AppController } from '../app/controller.js';
import { API_METHODS, EVENT_CHANNEL, apiChannel, isTrustedSender, type ApiResult } from './ipc-contract.js';

export type ShellOptions = {
  /** Abre o Chrome dedicado. */
  launch: () => Promise<BrowserContext>;
  /** Diretório com preload.cjs e ui/. */
  appDir: string;
};

/** Janela, segurança e ponte com o controlador. Nenhuma regra de negócio aqui. */
export function startDesktop({ launch, appDir }: ShellOptions): void {
  const uiDir = path.join(appDir, 'ui');
  const appUrl = pathToFileURL(path.join(uiDir, 'index.html')).href;
  const uiPrefix = `${pathToFileURL(uiDir).href}/`;

  let mainWindow: BrowserWindow | undefined;
  let quitting = false;
  let controller: AppController;

  /** A janela só carrega os arquivos do próprio aplicativo: sem rede, permissões, navegação ou novas janelas. */
  function hardenSession(): void {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(uiPrefix) }));
  }

  function registerApi(): void {
    for (const method of API_METHODS) {
      ipcMain.handle(apiChannel(method), async (event, arg: unknown): Promise<ApiResult<unknown>> => {
        const frame = event.senderFrame;
        if (!isTrustedSender(frame?.url, frame === event.sender.mainFrame, appUrl)) return { ok: false, error: { code: 'forbidden', message: 'Origem não autorizada.' } };
        try {
          return { ok: true, data: await (controller[method] as (a?: unknown) => unknown).call(controller, arg) };
        } catch (error) {
          return { ok: false, error: controller.describeError(error) };
        }
      });
    }
  }

  function createWindow(): void {
    mainWindow = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      title: 'AIR Organizer',
      backgroundColor: '#f5f6f8',
      webPreferences: {
        preload: path.join(appDir, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        devTools: !app.isPackaged,
      },
    });
    const { webContents } = mainWindow;
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    webContents.on('will-navigate', (event) => event.preventDefault());
    webContents.on('will-redirect', (event) => event.preventDefault());
    // Fechar a janela com uma leitura em andamento exige confirmação; a saída faz a parada controlada.
    mainWindow.on('close', (event) => {
      if (quitting || !controller.busy) return;
      const choice = dialog.showMessageBoxSync(mainWindow!, {
        type: 'warning',
        title: 'AIR Organizer',
        message: 'Há uma operação em andamento.',
        detail: 'Sair pede a parada controlada e preserva o checkpoint. A leitura ficará parcial.',
        buttons: ['Continuar a operação', 'Interromper e sair'],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice === 0) event.preventDefault();
    });
    mainWindow.on('closed', () => {
      mainWindow = undefined;
    });
    void mainWindow.loadURL(appUrl);
  }

  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  // Antes de sair: parada controlada, se houver leitura, e Chrome fechado, sem processo nem trava de perfil.
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void Promise.resolve(controller?.shutdown()).finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());

  void app.whenReady().then(async () => {
    controller = new AppController({
      launch,
      settingsFile: path.join(app.getPath('userData'), 'settings.json'),
      confirmDecisionHistoryReset: () =>
        mainWindow !== undefined &&
        dialog.showMessageBoxSync(mainWindow, {
          type: 'warning',
          title: 'AIR Organizer',
          message: 'Iniciar um novo histórico de decisões?',
          detail: 'O histórico atual deste inventário não pôde ser validado. Ele será guardado como cópia de recuperação, e as decisões dele NÃO serão importadas: o novo histórico começa vazio. Nada é alterado no AIR.',
          buttons: ['Cancelar', 'Guardar cópia e iniciar novo histórico'],
          defaultId: 0,
          cancelId: 0,
        }) === 1,
      emit: (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(EVENT_CHANNEL, event);
      },
    });
    await controller.init();
    Menu.setApplicationMenu(null);
    hardenSession();
    registerApi();
    createWindow();
  });
}
