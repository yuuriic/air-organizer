import { writeFile } from 'node:fs/promises';
import { app } from 'electron';
import type { Page } from 'playwright';
import { detectEnvironment } from '../../src/air/navigator.js';
import { launchDedicatedChrome } from '../../src/air/session.js';
import { createAirTreeNavigator } from '../../src/air/tree-navigator.js';
import { scanTree } from '../../src/core/tree-scanner.js';
import { CheckpointStore, defaultCheckpointLocations } from '../../src/storage/checkpoints.js';
import { newRunId } from '../../src/storage/export.js';
import type { TreeLimits } from '../../src/types/inventory.js';
import { airTreeHtml, type TreeNode } from './air-tree.js';

/**
 * Prova de runtime: roda DENTRO do processo principal do Electron e usa os módulos reais (Chrome
 * dedicado, adaptador, scanner e checkpoints) sobre a fixture SINTÉTICA. O perfil e a chave vêm de
 * LOCALAPPDATA temporário, definido pelo teste; a origem é falsa e nenhuma requisição sai da máquina.
 */
const ORIGIN = 'https://air.fixture.test';
const NAV = { timeoutMs: 5_000, pollMs: 40, readTimeoutMs: 5_000 };
const LIMITS: TreeLimits = { maxDepth: 5, maxFolders: 50, maxItems: 1_000, maxPagesPerFolder: 20 };
const dir = (id: string, name: string, children: TreeNode[] = []): TreeNode => ({ id, name, type: 'folder', children });
const TREE = dir('root', 'Setor', [dir('a', 'A', [dir('a1', 'A1')]), dir('b', 'B'), { id: 'f', name: 'documento.pdf', type: 'file' }]);
const read = <T>(page: Page, key: string) => page.evaluate((k) => (window as unknown as Record<string, T>)[k], key);

async function probe() {
  const context = await launchDedicatedChrome();
  try {
    const html = airTreeHtml({ root: TREE, pageSize: 2 });
    await context.route('**/*', (route) =>
      route.request().url().startsWith(`${ORIGIN}/`) ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort(),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${ORIGIN}/air/my-air/root`);

    const operator = { client: 'Cliente Sintético', sector: 'Setor Sintético' };
    const store = await CheckpointStore.open({ ...defaultCheckpointLocations(), retentionDays: 1 });
    const scope = store.scopeOf(await detectEnvironment(page, operator));
    if (!scope) throw new Error('escopo não identificado');
    const session = await store.create(scope, newRunId(), LIMITS);
    let events = 0;
    const result = await scanTree(createAirTreeNavigator(page, operator, NAV), LIMITS, {
      onEvent: () => void events++,
      checkpoint: { pseudonymize: store.pseudonymize, save: (snapshot) => session.save(snapshot) },
    });
    await session.release();
    return {
      electron: process.versions.electron,
      status: result.status,
      foldersRead: result.totals.foldersRead,
      events,
      visits: await read<string[]>(page, '__visits'),
      forbiddenClicks: await read<string[]>(page, '__forbiddenClicks'),
      // Execução concluída fica gravada, mas não é oferecida para retomada.
      checkpoints: (await store.list()).map((entry) => entry.rejection?.code ?? 'resumable'),
    };
  } finally {
    await context.close();
  }
}

// Sem `await` no nível superior: o Electron só dispara `ready` depois de carregar o script principal.
const output = process.env.AIR_ORGANIZER_PROBE_OUTPUT!;
void app.whenReady().then(async () => {
  try {
    await writeFile(output, JSON.stringify({ ok: true, ...(await probe()) }));
    app.exit(0);
  } catch (error) {
    await writeFile(output, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    app.exit(1);
  }
});
