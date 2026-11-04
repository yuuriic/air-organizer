import { chromium, type BrowserContext } from 'playwright';
import { airTreeHtml, type TreeFixtureOptions } from './air-tree.js';

/**
 * Carregado antes da CLI real, só nos testes: o Chrome dedicado responde com a fixture SINTÉTICA
 * (origem falsa; nenhuma requisição sai da máquina). A CLI em si não muda.
 */
const ORIGIN = 'https://air.fixture.test';
const options = JSON.parse(process.env.AIR_ORGANIZER_FIXTURE!) as TreeFixtureOptions;
const launch = chromium.launchPersistentContext.bind(chromium) as (...args: unknown[]) => Promise<BrowserContext>;

(chromium as unknown as { launchPersistentContext: typeof launch }).launchPersistentContext = async (...args) => {
  const context = await launch(...args);
  const html = airTreeHtml(options);
  await context.route('**/*', (route) =>
    route.request().url().startsWith(`${ORIGIN}/`) ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort(),
  );
  return context;
};
