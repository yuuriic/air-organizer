import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchDedicatedChrome } from '../../src/air/session.js';
import { startDesktop } from '../../src/desktop/shell.js';
import { airTreeHtml, type TreeFixtureOptions } from './air-tree.js';

/**
 * O aplicativo real, com a mesma janela, IPC e controlador, mas com o Chrome dedicado respondendo
 * com a fixture SINTÉTICA (origem falsa; nenhuma requisição sai da máquina). Só para testes: não há
 * atalho equivalente em produção.
 */
const ORIGIN = 'https://air.fixture.test';
const options = JSON.parse(process.env.AIR_ORGANIZER_FIXTURE!) as TreeFixtureOptions;
/** Só desta fixture: atraso da primeira resposta e abas extras já abertas ao iniciar. */
const harness = JSON.parse(process.env.AIR_ORGANIZER_FIXTURE_HARNESS ?? '{}') as { firstLoadDelayMs?: number; extraTabs?: string[] };
const here = path.dirname(fileURLToPath(import.meta.url));

startDesktop({
  appDir: path.resolve(here, '..', 'desktop'),
  launch: async () => {
    const context = await launchDedicatedChrome();
    const html = airTreeHtml(options);
    let delay = harness.firstLoadDelayMs ?? 0;
    await context.route('**/*', async (route) => {
      if (!route.request().url().startsWith(`${ORIGIN}/`)) return route.abort();
      const wait = delay;
      delay = 0;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    });
    for (const folder of harness.extraTabs ?? []) {
      const tab = await context.newPage();
      await tab.goto(`${ORIGIN}/air/my-air/${folder}`);
    }
    return context;
  },
});
