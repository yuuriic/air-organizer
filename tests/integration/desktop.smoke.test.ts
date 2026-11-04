import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron, chromium, type ElectronApplication, type Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_METHODS } from '../../src/desktop/ipc-contract.js';

/**
 * O aplicativo real, no Windows, com perfil, chave e dados em diretório TEMPORÁRIO. Abre janelas do
 * Chrome dedicado de verdade, mas sem navegar a nenhum site: nada sai da máquina.
 */
const ROOT = process.cwd();
const electronPath = createRequire(import.meta.url)('electron') as string;
const TIMEOUT = 60_000;

function isolatedEnv(base: string): Record<string, string> {
  const env = { ...process.env, LOCALAPPDATA: path.join(base, 'local'), APPDATA: path.join(base, 'roaming') } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'AIR_ORGANIZER_PROFILE_DIR', 'AIR_ORGANIZER_CHECKPOINT_DIR', 'AIR_ORGANIZER_URL']) delete env[key];
  return env;
}

/** Processos principais do Chrome com este perfil (sem os auxiliares, que têm --type=). */
function chromePids(profileDir: string): number[] {
  const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profileDir}*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { $_.ProcessId }`;
  const out = execFileSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf-8' });
  return out.split(/\s+/).filter(Boolean).map(Number);
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condição não atingida no prazo.');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

describe.runIf(process.platform === 'win32')('aplicativo desktop', () => {
  let base = '';
  let profileDir = '';
  let app: ElectronApplication;
  let page: Page;

  /** Pasta de execução temporária: `output/` é relativo a ela, e os testes nunca enxergam inventários reais. */
  const workDir = () => path.join(base, 'cwd');
  const launch = () => _electron.launch({ executablePath: electronPath, args: [ROOT, `--user-data-dir=${path.join(base, 'electron')}`], cwd: workDir(), env: isolatedEnv(base) });
  const chromeState = (text: string) => page.locator('#chrome-state', { hasText: new RegExp(`^${text}$`) }).waitFor({ timeout: TIMEOUT });

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-desktop-'));
    await mkdir(workDir(), { recursive: true });
    profileDir = path.join(base, 'local', 'air-organizer', 'chrome-profile');
    app = await launch();
    page = await app.firstWindow();
    await chromeState('Fechado'); // a página carregou e a comunicação com o processo principal respondeu
  }, TIMEOUT);

  afterEach(async () => {
    await app.close().catch(() => {});
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }, TIMEOUT);

  it('abre a janela com isolamento, sem Node, rede, navegação nem novas janelas', async () => {
    expect(await page.title()).toBe('AIR Organizer');
    expect(await page.locator('.mode').textContent()).toContain('Somente leitura');

    const prefs = await app.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0]!.webContents as unknown as { getLastWebPreferences(): unknown }).getLastWebPreferences());
    expect(prefs).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false });

    const before = page.url();
    const probe = await page.evaluate(async () => {
      const w = window as unknown as Record<string, unknown>;
      const inline = document.createElement('script');
      inline.textContent = 'window.__inline = true';
      document.head.append(inline);
      const fetched = await fetch('https://externo.test/').then(() => 'ok', () => 'blocked');
      const opened = window.open('https://externo.test/');
      window.location.href = 'https://externo.test/';
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { require: typeof w.require, process: typeof w.process, inline: w.__inline ?? false, fetched, opened: opened === null, api: Object.keys(window.airOrganizer).sort() };
    });
    expect(probe).toEqual({
      require: 'undefined',
      process: 'undefined',
      inline: false,
      fetched: 'blocked',
      opened: true,
      api: [...API_METHODS, 'onEvent'].sort(),
    });
    // A API exposta não tem operação de escrita no AIR.
    expect(API_METHODS.join(' ')).not.toMatch(/move|delete|remove|rename|merge|execute|create/i);
    expect(page.url()).toBe(before);
    expect(app.windows()).toHaveLength(1);
  }, TIMEOUT);

  it('navega pelas telas; sem pré-requisito, a ação fica desabilitada; não há ação de escrita', async () => {
    for (const [label, id, action] of [['Leitura', 'read', 'start-tree'], ['Diagnóstico', 'diagnostics', 'diag-run'], ['Planejamento', 'planning', 'plan-run']] as const) {
      await page.getByRole('button', { name: label, exact: true }).click();
      expect(await page.locator(`#${id}`).isVisible()).toBe(true);
      expect(await page.locator('#home').isVisible()).toBe(false);
      await page.waitForFunction((b) => (document.getElementById(b) as HTMLButtonElement).disabled, action); // sem Chrome / sem inventário
    }
    await page.getByRole('button', { name: 'Configurações', exact: true }).click();
    expect(await page.locator('#path-profile').textContent()).toBe(profileDir);
    expect(await page.locator('#path-checkpoints').textContent()).toBe(path.join(base, 'local', 'air-organizer', 'checkpoints'));
    expect(await page.locator('#path-output').textContent()).toBe(path.join(workDir(), 'output'));

    const labels = (await page.locator('button').allTextContents()).join(' ');
    expect(labels).not.toMatch(/mover|excluir|apagar|renomear|mesclar|executar/i);
  }, TIMEOUT);

  it('abre e fecha o Chrome dedicado pelo aplicativo, com uma única sessão', async () => {
    await chromeState('Fechado');
    expect(await page.locator('#close-chrome').isDisabled()).toBe(true);
    await page.evaluate(() => Promise.all([window.airOrganizer.openChrome(), window.airOrganizer.openChrome()]));
    await chromeState('Aberto');
    expect(chromePids(profileDir)).toHaveLength(1);
    expect(await page.locator('#open-chrome').isDisabled()).toBe(true);

    await page.locator('#close-chrome').click();
    await chromeState('Fechado');
    await until(() => chromePids(profileDir).length === 0);
    expect(await page.locator('#message').isHidden()).toBe(true);
  }, TIMEOUT);

  it('perfil já em uso: mensagem clara, sem caminhos, e recupera depois', async () => {
    const other = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: false });
    try {
      await page.locator('#open-chrome').click();
      await page.locator('#message').waitFor({ state: 'visible', timeout: TIMEOUT });
      const text = await page.locator('#message').textContent();
      expect(text).toMatch(/já está em uso/);
      expect(text).not.toContain(base);
      await chromeState('Fechado');
    } finally {
      await other.close();
    }
    await page.locator('#open-chrome').click();
    await chromeState('Aberto');
    expect(await page.locator('#message').isHidden()).toBe(true);
  }, TIMEOUT);

  it('Chrome encerrado por fora atualiza a tela; sair com o Chrome aberto não deixa processo', async () => {
    await page.locator('#open-chrome').click();
    await chromeState('Aberto');
    for (const pid of chromePids(profileDir)) process.kill(pid);
    await chromeState('Fechado');

    await page.locator('#open-chrome').click();
    await chromeState('Aberto');
    await app.close();
    await until(() => chromePids(profileDir).length === 0);
  }, TIMEOUT);

  it('uma segunda instância encerra sozinha e mantém a primeira', async () => {
    const second = spawn(electronPath, [ROOT, `--user-data-dir=${path.join(base, 'electron')}`], { cwd: workDir(), env: isolatedEnv(base), stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => second.on('exit', resolve));
    expect(code).toBe(0);
    expect(await page.title()).toBe('AIR Organizer');
  }, TIMEOUT);

  it('runtime: Playwright, Chrome dedicado, scanner e checkpoints funcionam dentro do Electron (dados sintéticos)', async () => {
    const outfile = path.join(ROOT, 'dist', 'desktop-probe', 'probe.mjs');
    await build({ entryPoints: [path.join(ROOT, 'tests', 'fixtures', 'electron-probe.ts')], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning' });
    const output = path.join(base, 'probe.json');
    const probe = spawn(electronPath, [outfile, `--user-data-dir=${path.join(base, 'probe')}`], {
      cwd: workDir(),
      env: { ...isolatedEnv(path.join(base, 'p')), AIR_ORGANIZER_PROBE_OUTPUT: output },
      stdio: 'ignore',
    });
    expect(await new Promise((resolve) => probe.on('exit', resolve))).toBe(0);
    const result = JSON.parse(await readFile(output, 'utf-8')) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, status: 'complete', foldersRead: 4, forbiddenClicks: [], checkpoints: ['finished'] });
    expect(result.electron).toBe((await app.evaluate(() => process.versions.electron)));
    expect(result.visits).toEqual(expect.arrayContaining(['a', 'a1', 'b']));
    expect(result.events).toBeGreaterThan(0);
  }, TIMEOUT);
});
