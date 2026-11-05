import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isResumable } from '../../src/core/checkpoint.js';
import { CheckpointStore, defaultCheckpointLocations } from '../../src/storage/checkpoints.js';
import type { TreeFixtureOptions, TreeNode } from '../fixtures/air-tree.js';

/**
 * Fluxo completo pela JANELA do aplicativo, sobre a fixture SINTÉTICA, com perfil, chave, saídas e
 * configurações em diretório temporário.
 */
const ROOT = process.cwd();
const ORIGIN = 'https://air.fixture.test';
const electronPath = createRequire(import.meta.url)('electron') as string;
const MAIN = path.join(ROOT, 'dist', 'desktop-flow', 'fixture-main.mjs');
const TIMEOUT = 120_000;
/** Espera por elemento: menor que o prazo do teste, para a falha citar o elemento e o estado da tela. */
const WAIT = 30_000;
/**
 * Prazo da fixture para navegar e ler (o padrão do aplicativo). Precisa ser folgado: sob carga, a
 * navegação inicial pode demorar vários segundos, e, se o prazo estourar, a sessão abre com a aba em
 * branco, por desenho (§5.2), e a verificação de conexão falha com "Nenhuma aba HTTP(S)". Menor que
 * WAIT, para a falha citar o elemento e o estado da tela.
 */
const PAGE_TIMEOUT = '15000';
const SENSITIVE = ['Orbitas', 'ORBITAS', 'Planetas', 'PLANETAS', 'Alfa', 'Beta', 'Gama', '.pdf'];

const dir = (id: string, name: string, children: TreeNode[] = []): TreeNode => ({ id, name, type: 'folder', children });
const doc = (id: string): TreeNode => ({ id, name: `documento ${id}.pdf`, type: 'file' });
const TREE = dir('root', 'Setor', [
  dir('o1', 'ORBITAS', [doc('a')]),
  dir('o2', 'Orbitas', [doc('b')]),
  dir('x', 'Alfa', [dir('p1', 'Planetas', [doc('c')])]),
  dir('y', 'Beta', [dir('p2', 'Planetas', [doc('d')])]),
  dir('z', 'Gama', [dir('p3', 'PLANETAS', [doc('e')])]),
]);
const WIDE = { maxDepth: 5, maxFolders: 50, maxItems: 1_000, maxPagesPerFolder: 10 };

type Harness = { firstLoadDelayMs?: number; extraTabs?: string[] };

function env(base: string, fixture: TreeFixtureOptions, harness: Harness): Record<string, string> {
  const out = { ...process.env, AIR_ORGANIZER_FIXTURE_HARNESS: JSON.stringify(harness), LOCALAPPDATA: path.join(base, 'local'), APPDATA: path.join(base, 'roaming'), AIR_ORGANIZER_FIXTURE: JSON.stringify(fixture), AIR_ORGANIZER_PAGE_TIMEOUT_MS: PAGE_TIMEOUT } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'AIR_ORGANIZER_PROFILE_DIR', 'AIR_ORGANIZER_CHECKPOINT_DIR', 'AIR_ORGANIZER_URL', 'AIR_ORGANIZER_MAX_PAGES', 'AIR_ORGANIZER_INVENTORY_MAX_AGE_DAYS', 'AIR_ORGANIZER_VERBOSE_ERRORS']) delete out[key];
  return out;
}

describe.runIf(process.platform === 'win32')('fluxo pela janela do aplicativo (dados sintéticos)', () => {
  let base = '';
  let app: ElectronApplication | undefined;
  let page: Page;

  async function start(fixture: TreeFixtureOptions, startFolder = 'root', harness: Harness = {}): Promise<void> {
    base = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-desktop-'));
    const userData = path.join(base, 'electron');
    await mkdir(userData, { recursive: true });
    await writeFile(path.join(userData, 'settings.json'), JSON.stringify({ instanceUrl: `${ORIGIN}/air/my-air/${startFolder}` }));
    await launchApp(fixture, harness);
  }
  async function launchApp(fixture: TreeFixtureOptions, harness: Harness = {}): Promise<void> {
    await mkdir(path.join(base, 'cwd'), { recursive: true });
    app = await _electron.launch({ executablePath: electronPath, args: [MAIN, `--user-data-dir=${path.join(base, 'electron')}`], cwd: path.join(base, 'cwd'), env: env(base, fixture, harness) });
    page = await app.firstWindow();
    await page.locator('#chrome-state', { hasText: /^Fechado$/ }).waitFor({ timeout: WAIT });
  }
  const go = (label: string) => page.getByRole('button', { name: label, exact: true }).click();
  const confirm = () => page.locator('#confirm-yes').click();
  async function openChrome(): Promise<void> {
    await go('Início');
    await page.locator('#open-chrome').click();
    await page.locator('#chrome-state', { hasText: /^Aberto$/ }).waitFor({ timeout: WAIT });
  }
  async function fill(prefix: string, limits: Record<string, number>): Promise<void> {
    for (const [key, value] of Object.entries(limits)) await page.locator(`#${prefix}-${key}`).fill(String(value));
  }
  const idle = () => page.locator('#op-bar').waitFor({ state: 'hidden', timeout: WAIT });
  const text = (selector: string) => page.locator(selector).innerText();
  const files = async () => {
    const found: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory()) await walk(path.join(d, e.name));
        else found.push(path.join(d, e.name));
      }
    };
    await walk(path.join(base, 'cwd', 'output'));
    return found;
  };

  beforeAll(async () => {
    await build({ entryPoints: [path.join(ROOT, 'tests', 'fixtures', 'desktop-fixture-main.ts')], outfile: MAIN, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning' });
  }, TIMEOUT);

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') {
      const state = await page.evaluate(() => ['chrome-state', 'air-state', 'message', 'op-title'].map((id) => `${id}=${document.getElementById(id)?.textContent ?? ''}`).join(' | ')).catch(() => 'janela indisponível');
      console.error(`[estado da tela] ${state}`);
    }
    await app?.close().catch(() => {});
    app = undefined;
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }, TIMEOUT);

  it('conexão, leitura completa, inventário selado, diagnóstico e planejamento não executável', async () => {
    await start({ root: TREE, pageSize: 30 });
    await openChrome();

    await page.locator('#check-connection').click();
    await page.locator('#air-state', { hasText: 'Listagem do AIR detectada' }).waitFor({ timeout: WAIT });
    expect(await text('#connection-result')).not.toContain('air.fixture.test');

    await go('Leitura');
    await page.locator('#op-client').fill('Cliente Sintético');
    await page.locator('#op-sector').fill('Setor Sintético');
    await page.locator('#read-folder').click();
    await confirm();
    await page.locator('#folder-result .notice').waitFor({ timeout: WAIT });
    expect(await text('#folder-result')).toContain('COMPLETA');
    expect(await text('#folder-result')).not.toMatch(/ORBITAS|Orbitas/); // nomes só com confirmação

    await fill('tree', WIDE);
    await page.locator('#start-tree').click();
    await confirm();
    await page.locator('#tree-result .notice').waitFor({ timeout: WAIT });
    expect(await text('#tree-result')).toContain('CONCLUÍDO');
    expect(await page.locator('#op-log').textContent()).toContain('F1 lida');

    // Sem o inventário detalhado, não há o que diagnosticar.
    await go('Diagnóstico');
    expect(await page.locator('#diag-run').isDisabled()).toBe(true);

    await go('Leitura');
    await page.getByRole('button', { name: 'Gravar inventário detalhado' }).last().click();
    await confirm();
    await page.locator('#message.ok').waitFor({ timeout: WAIT });

    await go('Diagnóstico');
    await page.locator('#diag-run:not([disabled])').click();
    await page.locator('#diag-result .notice').waitFor({ timeout: WAIT });
    expect(await text('#diag-result .notice')).toContain('ELEGÍVEL');
    const diag = await text('#diag-result');
    expect(diag).toContain('AUTENTICADA');
    expect(diag).toContain('DUP-SIBLING-NORMALIZED');
    for (const name of SENSITIVE) expect(diag).not.toContain(name);

    await go('Planejamento');
    await page.locator('#plan-run:not([disabled])').click();
    await page.locator('#plan-result .notice').waitFor({ timeout: WAIT });
    expect(await text('#plan-result .notice')).toContain('NÃO EXECUTÁVEIS');
    const cards = page.locator('#plan-result article.card');
    expect(await cards.count()).toBeGreaterThan(0);
    for (let i = 0; i < (await cards.count()); i++) {
      const card = await cards.nth(i).innerText();
      expect(card).toContain('Não executável');
      expect(card).toContain('Pendente de revisão');
    }
    const plan = await text('#plan-result');
    for (const name of SENSITIVE) expect(plan).not.toContain(name);
    // Nenhum botão aplica nada: só nomes e gravação local.
    const actions = (await page.locator('#planning button').allInnerTexts()).join(' | ');
    expect(actions).not.toMatch(/mover|excluir|apagar|renomear|mesclar|executar|aplicar/i);

    // Nomes só depois de confirmar.
    await page.getByRole('button', { name: 'Mostrar nomes' }).click();
    await confirm();
    await page.locator('#plan-result .names').waitFor({ timeout: WAIT });
    expect(await text('#plan-result .names')).toMatch(/ORBITAS|Orbitas/);

    const written = await files();
    const names = written.map((f) => path.basename(f)).sort();
    expect(names).toEqual(expect.arrayContaining(['tree-diagnostic.json', 'tree-inventory.json', 'structural-diagnostics.json', 'organization-plan.json']));
    const redactedPlan = await readFile(written.find((f) => f.endsWith('organization-plan.json'))!, 'utf-8');
    const parsed = JSON.parse(redactedPlan) as { executable: boolean; authorizesChanges: boolean; proposals: Array<{ executable: boolean }> };
    expect(parsed).toMatchObject({ executable: false, authorizesChanges: false });
    expect(parsed.proposals.every((p) => p.executable === false)).toBe(true);
    for (const name of SENSITIVE) expect(redactedPlan).not.toContain(name);
  }, TIMEOUT);

  it('prévia de movimentações: nomes ocultos, revelados só com confirmação e ocultos de novo; nada é gravado', async () => {
    await start({ root: TREE, pageSize: 30 });
    await openChrome();
    await go('Leitura');
    await page.locator('#op-client').fill('Cliente Sintético');
    await page.locator('#op-sector').fill('Setor Sintético');
    await fill('tree', WIDE);
    await page.locator('#start-tree').click();
    await confirm();
    await page.locator('#tree-result .notice').waitFor({ timeout: WAIT });
    await page.getByRole('button', { name: 'Gravar inventário detalhado' }).last().click();
    await confirm();
    await page.locator('#message.ok').waitFor({ timeout: WAIT });

    await go('Planejamento');
    await page.locator('#plan-select option[value^="inv-"]').first().waitFor({ state: 'attached', timeout: WAIT });
    await page.locator('#move-load:not([disabled])').click();
    await page.locator('#move-inventory .notice', { hasText: 'ELEGÍVEL' }).waitFor({ timeout: WAIT });
    await page.locator('#move-picker:not([hidden])').waitFor({ timeout: WAIT });
    expect(await text('#move-inventory')).toContain('COMPLETA');

    // HTML inteiro da tela: cobre opções, atributos, títulos e rótulos de acessibilidade.
    const expectNoNames = async () => {
      const html = await page.locator('#planning').evaluate((node) => node.outerHTML);
      for (const name of SENSITIVE) expect(html).not.toContain(name);
    };
    await expectNoNames();

    const before = (await files()).length;
    // Sem a escolha do que fazer com a pasta, nada é presumido.
    const options = () => page.locator('#move-source option').evaluateAll((list) => list.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? '' })));
    await page.getByRole('button', { name: 'Revelar nomes da seleção' }).click();
    await page.locator('#confirm-no').click();
    await expectNoNames();

    await page.getByRole('button', { name: 'Revelar nomes da seleção' }).click();
    await confirm();
    await page.getByRole('button', { name: 'Ocultar nomes' }).waitFor({ timeout: WAIT });
    const listed = await options();
    const alfa = listed.findIndex((o) => o.text.includes('Alfa'));
    const source = listed.slice(alfa).find((o) => o.text.includes('Planetas'))!.value;
    const destination = listed.find((o) => o.text.includes('Beta'))!.value;

    await page.locator('#move-source').selectOption(source);
    await page.locator('#move-destination').selectOption(destination);
    // A própria origem não é um destino possível.
    expect(await page.locator(`#move-destination option[value="${source}"]`).evaluate((o) => (o as HTMLOptionElement).disabled)).toBe(true);
    await page.locator('#move-generate').click();
    await page.locator('#message.error', { hasText: 'o que fazer com a pasta' }).waitFor({ timeout: WAIT });

    await page.locator('input[name="move-mode"][value="folder"]').check();
    await page.locator('#move-generate').click();
    await page.locator('#move-result .notice', { hasText: 'NÃO EXECUTÁVEIS' }).waitFor({ timeout: WAIT });
    // Consolida na "Planetas" existente em Beta: o agrupamento e o arquivo, sem pasta duplicada.
    expect(await page.locator('#move-result article.card').count()).toBe(2);
    expect(await page.locator('#move-result article.card').first().innerText()).toContain('Consolidação');
    for (const card of await page.locator('#move-result article.card').allInnerTexts()) expect(card).toContain('Não executável');
    expect(await text('#move-result')).toContain('documento c.pdf');

    await page.getByRole('button', { name: 'Ocultar nomes' }).click();
    await page.getByRole('button', { name: 'Revelar nomes da seleção' }).waitFor({ timeout: WAIT });
    await expectNoNames();
    // A seleção continua pelos identificadores, com os nomes ocultos.
    expect(await page.locator('#move-source').inputValue()).toBe(source);
    await page.locator('#move-generate').click();
    await page.locator('#move-result .notice', { hasText: 'NÃO EXECUTÁVEIS' }).waitFor({ timeout: WAIT });
    await expectNoNames();

    const summary = await text('#move-result');
    for (const expected of ['Total de propostas', 'Prontas para revisão', 'Bloqueadas', 'Consolidações', 'Motivos de bloqueio: nenhum', 'Seleção desta prévia', 'all-ready', 'só agrupa: não libera']) expect(summary).toContain(expected);

    // Corrigir a seleção invalida a prévia: destino, modo e origem.
    const previewGone = () => page.locator('#move-result article.card').count();
    const generate = async () => {
      await page.locator('#move-generate').click();
      await page.locator('#move-result .notice', { hasText: 'NÃO EXECUTÁVEIS' }).waitFor({ timeout: WAIT });
    };
    const otherFolder = listed.find((o) => o.text.includes('Gama'))!.value;
    await page.locator('#move-destination').selectOption(otherFolder);
    expect(await previewGone()).toBe(0);
    await generate();
    await page.locator('input[name="move-mode"][value="folder-contents"]').check();
    expect(await previewGone()).toBe(0);
    await generate();
    const sibling = listed.find((o) => o.text.includes('Alfa'))!.value;
    await page.locator('#move-source').selectOption(sibling);
    expect(await previewGone()).toBe(0);
    // Trocar a origem também limpa o modo: nada é presumido para a nova pasta.
    expect(await page.locator('input[name="move-mode"]:checked').count()).toBe(0);

    /** Resposta obsoleta: o pedido sai e a seleção muda no mesmo instante, antes de qualquer resposta. */
    const settled = async () => {
      await idle();
      await page.evaluate(() => (window as unknown as { airOrganizer: { status(): Promise<unknown> } }).airOrganizer.status());
    };
    await page.locator('input[name="move-mode"][value="folder"]').check();
    await page.evaluate(() => {
      document.getElementById('move-generate')!.click();
      const destination = document.getElementById('move-destination') as HTMLSelectElement;
      destination.selectedIndex = 0;
      destination.dispatchEvent(new Event('change'));
    });
    await settled();
    expect(await previewGone()).toBe(0);

    // Trocar de inventário invalida seleções, nomes e prévia, mesmo com um pedido em andamento.
    await page.locator('#move-destination').selectOption(destination);
    await generate();
    await page.getByRole('button', { name: 'Revelar nomes da seleção' }).click();
    await confirm();
    await page.getByRole('button', { name: 'Ocultar nomes' }).waitFor({ timeout: WAIT });
    await page.evaluate(() => {
      document.getElementById('move-generate')!.click();
      document.getElementById('plan-select')!.dispatchEvent(new Event('change'));
    });
    await settled();
    expect(await previewGone()).toBe(0);
    expect(await page.locator('#move-picker').isHidden()).toBe(true);
    expect(await page.locator('#move-names').isHidden()).toBe(true);
    await expectNoNames();

    expect((await files()).length).toBe(before);
    const actions = (await page.locator('#planning button').allInnerTexts()).join(' | ');
    expect(actions).not.toMatch(/mover|excluir|apagar|renomear|mesclar|executar|aplicar/i);
  }, TIMEOUT);

  it('prévia com bloqueios: destaque, motivos, quadro da seleção, ordem segura e etiquetas, sem vazar nomes', async () => {
    const CONFLICT_TREE = dir('root', 'Raizfic', [
      dir('o', 'Fontefic', [dir('o25', 'Ciclofic', [{ id: 'a', name: 'ata.pdf', type: 'file' }, { id: 'b', name: 'lista.pdf', type: 'file' }])]),
      dir('d', 'Alvofic', [dir('d25', 'Ciclofic', [{ id: 'e', name: 'ata.pdf', type: 'file' }])]),
    ]);
    const PRIVATE = ['Fontefic', 'Alvofic', 'Ciclofic', 'ata.pdf', 'lista.pdf', 'Raizfic'];
    await start({ root: CONFLICT_TREE, pageSize: 30 });
    await openChrome();
    await go('Leitura');
    await page.locator('#op-client').fill('Cliente Sintético');
    await page.locator('#op-sector').fill('Setor Sintético');
    await fill('tree', WIDE);
    await page.locator('#start-tree').click();
    await confirm();
    await page.locator('#tree-result .notice').waitFor({ timeout: WAIT });
    await page.getByRole('button', { name: 'Gravar inventário detalhado' }).last().click();
    await confirm();
    await page.locator('#message.ok').waitFor({ timeout: WAIT });

    await go('Planejamento');
    await page.locator('#plan-select option[value^="inv-"]').first().waitFor({ state: 'attached', timeout: WAIT });
    await page.locator('#move-load:not([disabled])').click();
    await page.locator('#move-picker:not([hidden])').waitFor({ timeout: WAIT });
    const expectHidden = async () => {
      // Só a prévia: o HTML dela cobre quadro, ordem, cartões, atributos e rótulos.
      const html = await page.locator('#move-result').evaluate((node) => node.outerHTML);
      for (const name of PRIVATE) expect(html).not.toContain(name);
    };

    // Texto da confirmação fala em pastas E arquivos.
    await page.getByRole('button', { name: 'Revelar nomes da seleção' }).click();
    await page.locator('#confirm').waitFor({ timeout: WAIT });
    expect(await text('#confirm-body')).toMatch(/nomes de pastas e arquivos/);
    await confirm();
    await page.getByRole('button', { name: 'Ocultar nomes' }).waitFor({ timeout: WAIT });
    const listed = await page.locator('#move-source option').evaluateAll((list) => list.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? '' })));
    const origem = listed.findIndex((o) => o.text.includes('Fontefic'));
    const source = listed.slice(origem).find((o) => o.text.includes('Ciclofic'))!.value;
    const destination = listed.find((o) => o.text.includes('Alvofic'))!.value;
    const file = listed.find((o) => o.text.includes('lista.pdf'))!.value;
    await page.getByRole('button', { name: 'Ocultar nomes' }).click();
    await page.getByRole('button', { name: 'Revelar nomes da seleção' }).waitFor({ timeout: WAIT });

    await page.locator('#move-source').selectOption(source);
    await page.locator('#move-destination').selectOption(destination);
    await page.locator('input[name="move-mode"][value="folder"]').check();
    await page.locator('#move-generate').click();
    await page.locator('#move-summary', { hasText: 'NÃO EXECUTÁVEIS' }).waitFor({ timeout: WAIT });

    // Resumo: atenção, não sucesso; motivos reais do motor.
    expect(await page.locator('#move-summary').getAttribute('class')).toContain('warn');
    expect(await text('#move-summary')).toContain('COM BLOQUEIOS');
    const summary = await text('#move-result');
    expect(summary).toContain('Motivos de bloqueio');
    expect(summary).toContain('Conflitos: mesmo nome no destino: 1');
    expect(summary).not.toMatch(/Motivos de bloqueio: nenhum|Categorias de bloqueio: nenhuma/);

    // Estados diferentes na aparência E no texto.
    const blocked = page.locator('#move-result article.card[data-state="blocked"]');
    const ready = page.locator('#move-result article.card[data-state="ready-for-review"]').last();
    expect(await blocked.count()).toBe(1);
    const borderOf = (card: typeof blocked) => card.evaluate((node) => getComputedStyle(node).borderLeftColor + getComputedStyle(node).borderLeftWidth);
    expect(await borderOf(blocked)).not.toBe(await borderOf(ready));
    const blockedText = await blocked.innerText();
    expect(blockedText).toContain('⚠ Bloqueada (blocked)');
    expect(blockedText).toContain('Não executável');
    expect(blockedText).not.toContain('Pendente de revisão');
    expect(blockedText).not.toMatch(/Apta para revisão/);
    expect(await ready.innerText()).toContain('Pendente de revisão');
    expect(await page.locator('#move-result article.card').first().innerText()).toContain('⚠ Parcialmente bloqueada');
    // Nenhuma etiqueta apresenta proposta como aprovada, autorizada ou executável.
    const tags = await page.locator('#move-result article.card .tag').allInnerTexts();
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).not.toMatch(/aprovad|autorizad|^execut/i);
    expect(tags.filter((tag) => tag === 'Não executável')).toHaveLength(await page.locator('#move-result article.card').count());

    // Quadro da seleção: inventário, origem, destino e modo, com nomes ocultos.
    const box = await text('#move-selection');
    expect(box).toContain('output/*/*/');
    expect(box).toContain(`Pasta ${source}`);
    expect(box).toContain(`Pasta ${destination}`);
    expect(box).toContain('Levar a pasta para dentro do destino');

    // Ordem segura legível, sem a operação bloqueada, com os identificadores só como referência.
    const order = page.locator('#move-order li');
    expect(await order.count()).toBe(2);
    expect(await order.first().innerText()).toMatch(new RegExp(`^Consolidação \\(agrupamento\\): Pasta ${source}.*→ Pasta .*\\(M-[0-9a-f]{16}\\)$`));
    const blockedId = await blocked.locator('.refs').innerText();
    expect(await text('#move-order')).not.toContain(blockedId);
    expect(await text('#move-order')).toContain('Arquivo:');
    await expectHidden();

    // Nomes revelados no quadro e na ordem; ocultar remove de ambos.
    await page.getByRole('button', { name: 'Revelar nomes da seleção' }).click();
    await confirm();
    await page.getByRole('button', { name: 'Ocultar nomes' }).waitFor({ timeout: WAIT });
    expect(await text('#move-selection')).toContain('Ciclofic');
    expect(await text('#move-selection')).toContain('Alvofic');
    expect(await text('#move-order')).toContain('lista.pdf');
    await page.getByRole('button', { name: 'Ocultar nomes' }).click();
    await page.getByRole('button', { name: 'Revelar nomes da seleção' }).waitFor({ timeout: WAIT });
    await expectHidden();

    // O quadro reflete quem gerou a prévia: mudar a seleção invalida a prévia e o quadro juntos.
    await page.locator('input[name="move-mode"][value="folder-contents"]').check();
    expect(await page.locator('#move-selection').count()).toBe(0);
    expect(await page.locator('#move-result article.card').count()).toBe(0);
    await page.locator('#move-generate').click();
    await page.locator('#move-selection').waitFor({ timeout: WAIT });
    expect(await text('#move-selection')).toContain('Consolidar o conteúdo da pasta no destino');

    // Arquivo como origem: o modo não se aplica, e não há bloqueios nem aparência de atenção.
    await page.locator('#move-source').selectOption(file);
    expect(await page.locator('#move-selection').count()).toBe(0);
    await page.locator('#move-generate').click();
    await page.locator('#move-selection').waitFor({ timeout: WAIT });
    expect(await text('#move-selection')).toContain('não se aplica');
    expect(await page.locator('#move-summary').getAttribute('class')).toContain('ok');
    expect(await text('#move-result')).toContain('Motivos de bloqueio: nenhum');
    await expectHidden();
  }, TIMEOUT);

  it('parada controlada: Chrome segue aberto, leitura parcial, plano recusado; retomada VERIFICADA completa e planejável', async () => {
    await start({ root: TREE, pageSize: 30, renderDelayMs: 350 });
    await openChrome();
    await go('Leitura');
    await fill('tree', WIDE);
    await page.locator('#start-tree').click();
    await confirm();

    await page.locator('#op-progress', { hasText: /Pastas [1-9]/ }).waitFor({ timeout: WAIT });
    await page.locator('#op-stop').click();
    await page.locator('#op-title', { hasText: 'Parando' }).waitFor({ timeout: WAIT });
    expect(await page.locator('#close-chrome').isDisabled()).toBe(true); // fechar não é o mecanismo normal
    await idle();

    const stopped = await text('#tree-result');
    expect(stopped).toContain('INTERROMPIDA a seu pedido');
    expect(stopped).toContain('run-aborted');
    expect(stopped).not.toContain('CONCLUÍDO');
    await page.getByRole('button', { name: 'Início', exact: true }).click();
    expect(await text('#chrome-state')).toBe('Aberto');

    // Inventário da leitura parada não fundamenta plano.
    await go('Leitura');
    await page.locator('#tree-result').getByRole('button', { name: 'Gravar inventário detalhado' }).click();
    await confirm();
    await page.locator('#message.ok').waitFor({ timeout: WAIT });
    await go('Planejamento');
    await page.locator('#plan-run:not([disabled])').click();
    await page.locator('#plan-result .notice').waitFor({ timeout: WAIT });
    expect(await text('#plan-result .notice')).toContain('RECUSADO');
    expect(await page.locator('#plan-result article.card').count()).toBe(0);
    expect((await files()).some((f) => f.endsWith('organization-plan.json'))).toBe(false);

    // Retomada a partir da mesma pasta inicial (a parada voltou a ela).
    await go('Leitura');
    await page.locator('#list-resumable').click();
    await page.locator('#start-resume').waitFor({ timeout: WAIT });
    expect(await text('#resume-result')).toMatch(/pendências [1-9]/);
    await page.locator('#start-resume').click();
    await confirm();
    await page.locator('#resume-result .notice').waitFor({ timeout: WAIT });
    const resumed = await text('#resume-result');
    expect(resumed).toContain('CONCLUÍDO');
    expect(resumed).toContain('VERIFICADA');
    expect(resumed).not.toContain('run-aborted');

    await page.locator('#resume-result').getByRole('button', { name: 'Gravar inventário detalhado' }).click();
    await confirm();
    await page.locator('#message.ok').waitFor({ timeout: WAIT });
    await go('Planejamento');
    await page.locator('#plan-refresh').click();
    // O inventário mais recente vem primeiro.
    await page.locator('#plan-select option').first().waitFor({ state: 'attached', timeout: WAIT });
    await page.locator('#plan-select').selectOption({ index: 0 });
    await page.locator('#plan-run').click();
    await page.locator('#plan-result .notice', { hasText: 'NÃO EXECUTÁVEIS' }).waitFor({ timeout: WAIT });
  }, TIMEOUT);

  it('erros aparecem na tela, sem nomes; configurações são validadas, sem segredos, e valem após reabrir', async () => {
    await start({ root: TREE, pageSize: 30 }, 'root');

    // Sem Chrome, as ações que dependem dele ficam desabilitadas.
    await go('Leitura');
    for (const id of ['read-folder', 'list-subfolders', 'start-tree', 'list-resumable']) expect(await page.locator(`#${id}`).isDisabled()).toBe(true);

    await go('Configurações');
    expect(await page.locator('#setting-instanceUrl').inputValue()).toBe(`${ORIGIN}/air/my-air/root`);
    await page.locator('#setting-instanceUrl').fill('http://sem-https.test/');
    await page.locator('#setting-maxPages').fill('0');
    await page.locator('#setting-profileDir').fill('relativo');
    await page.locator('#settings-save').click();
    await page.locator('#message.error').waitFor({ timeout: WAIT });
    expect(await text('#setting-error-instanceUrl')).toContain('HTTPS');
    expect(await text('#setting-error-maxPages')).toContain('inteiro');
    expect(await text('#setting-error-profileDir')).toContain('absoluto');
    const file = path.join(base, 'electron', 'settings.json');
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual({ instanceUrl: `${ORIGIN}/air/my-air/root` }); // nada foi gravado

    await page.locator('#setting-instanceUrl').fill(`${ORIGIN}/air/my-air/o1?token=segredo#x`);
    await page.locator('#setting-maxPages').fill('7');
    await page.locator('#setting-profileDir').fill('');
    await page.locator('#settings-save').click();
    await page.locator('#message.ok').waitFor({ timeout: WAIT });
    const saved = await readFile(file, 'utf-8');
    expect(saved).not.toContain('segredo'); // query e fragmento são descartados
    expect(JSON.parse(saved)).toEqual({ instanceUrl: `${ORIGIN}/air/my-air/o1`, maxPages: 7 });

    // Arquivo com campo de segredo é recusado inteiro na próxima abertura.
    await app!.close();
    await writeFile(file, JSON.stringify({ instanceUrl: `${ORIGIN}/air/my-air/root`, password: 'x' }));
    await launchApp({ root: TREE, pageSize: 30 });
    await go('Configurações');
    await page.locator('#settings-problem:not([hidden])').waitFor({ timeout: WAIT });
    expect(await page.locator('#setting-instanceUrl').inputValue()).toBe('');
    expect(await readFile(file, 'utf-8')).toContain('password'); // não apagado sem pedir

    // Falha de navegação: pasta errada ao abrir; aparece como interrompida, sem nomes.
    await page.locator('#setting-instanceUrl').fill(`${ORIGIN}/air/my-air/root`);
    await page.locator('#settings-save').click();
    await page.locator('#message.ok').waitFor({ timeout: WAIT });
    await app!.close();
    await launchApp({ root: TREE, pageSize: 30, misrouteTo: { o2: 'x' } });
    await openChrome();
    await go('Leitura');
    await fill('tree', { ...WIDE });
    await page.locator('#start-tree').click();
    await confirm();
    await page.locator('#tree-result .notice').waitFor({ timeout: WAIT });
    const failed = await text('#tree-result');
    expect(await page.locator('#tree-result .notice').getAttribute('class')).toContain('error');
    expect(failed).toContain('INTERROMPIDO');
    expect(failed).toContain('navigation-lost');
    for (const name of SENSITIVE) expect(failed).not.toContain(name);
  }, TIMEOUT);

  it('subpasta: nomes só ao listar e tratados como texto; lê, volta, mostra duplicidades e exporta', async () => {
    const hostile = '<img src=x onerror="window.__xss=1">';
    await start({ root: dir('root', 'Setor', [dir('h', hostile.replace('<', '&lt;').replace('>', '&gt;')), dir('s', 'Simples', [doc('a'), { id: 'a2', name: 'DOCUMENTO A.PDF', type: 'file' }])]), pageSize: 30 });
    await openChrome();
    await go('Leitura');
    expect(await text('#read')).not.toContain('Simples');
    await page.locator('#list-subfolders').click();
    await page.locator('#subfolder-list:not([hidden])').waitFor({ timeout: WAIT });
    expect(await page.locator('#subfolder-select option').allTextContents()).toEqual([hostile, 'Simples']);

    // Nome hostil na listagem e na confirmação é só texto. Cancelar não abre nada.
    await page.locator('#read-subfolder:not([disabled])').click();
    expect(await text('#confirm-body')).toContain(hostile);
    await page.locator('#confirm-no').click();
    await page.locator('#subfolder-select').selectOption({ index: 1 });
    await page.locator('#read-subfolder').click();
    await confirm();
    await page.locator('#folder-result .notice').waitFor({ timeout: WAIT });
    expect(await text('#folder-result')).toContain('COMPLETA');
    expect(await text('#folder-result')).toContain('D1');
    expect(await text('#folder-result')).not.toMatch(/\.pdf/i);

    await page.getByRole('button', { name: 'Mostrar nomes' }).click();
    await confirm();
    await page.locator('#folder-result .names').waitFor({ timeout: WAIT });
    expect(await text('#folder-result .names')).toMatch(/documento a\.pdf/i);

    await page.getByRole('button', { name: 'Gravar relatório sem nomes' }).click();
    await page.locator('#message.ok').waitFor({ timeout: WAIT });
    let names = (await files()).map((f) => path.basename(f));
    expect(names).toContain('inventory-diagnostic.json');
    expect(names).not.toContain('inventory.json');
    await page.locator('#folder-result').getByRole('button', { name: 'Gravar inventário detalhado' }).click();
    await page.locator('#confirm-no').click(); // cancelar não grava
    names = (await files()).map((f) => path.basename(f));
    expect(names).not.toContain('inventory.json');

    // A leitura voltou à pasta anterior: a próxima listagem é a do pai.
    await page.locator('#list-subfolders').click();
    await page.locator('#subfolder-list:not([hidden])').waitFor({ timeout: WAIT });
    expect(await page.locator('#subfolder-select option').count()).toBe(2);
    expect(await page.evaluate(() => ({ xss: (window as unknown as { __xss?: number }).__xss ?? 0, imgs: document.images.length }))).toEqual({ xss: 0, imgs: 0 });
  }, TIMEOUT);

  /** Checkpoint gravado: íntegro (digest), sem trava presa, retomável e sem nomes. */
  async function expectResumableCheckpoint(): Promise<void> {
    const local = path.join(base, 'local');
    const locations = defaultCheckpointLocations({ LOCALAPPDATA: local });
    const store = await CheckpointStore.open({ ...locations, retentionDays: 1, repositoryDir: ROOT });
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.rejection).toBeUndefined();
    expect(isResumable(entries[0]!.checkpoint!.folders)).toBe(true);
    const raw = await readFile(path.join(entries[0]!.runDir, 'checkpoint.json'), 'utf-8');
    for (const name of SENSITIVE) expect(raw).not.toContain(name);
  }

  /** Retoma pela janela e confere que nada pendente foi ignorado. */
  async function resumeToCompletion(): Promise<void> {
    await openChrome();
    await go('Leitura');
    await page.locator('#list-resumable').click();
    await page.locator('#start-resume').waitFor({ timeout: WAIT });
    await page.locator('#start-resume').click();
    await confirm();
    await page.locator('#resume-result .notice').waitFor({ timeout: WAIT });
    const resumed = await text('#resume-result');
    expect(resumed).toContain('CONCLUÍDO');
    expect(resumed).not.toContain('run-aborted');
    expect(resumed).not.toContain('Pendências');
  }

  async function startSlowTree(): Promise<void> {
    await openChrome();
    await go('Leitura');
    await fill('tree', WIDE);
    await page.locator('#start-tree').click();
    await confirm();
    await page.locator('#op-progress', { hasText: /Pastas [1-9]/ }).waitFor({ timeout: WAIT });
  }

  it('regressão: "Aberto" só depois da navegação inicial; verificar logo em seguida não dá erro falso', async () => {
    await start({ root: TREE, pageSize: 30 }, 'root', { firstLoadDelayMs: 2_500 });
    await page.locator('#open-chrome').click();
    await page.locator('#chrome-state', { hasText: /^Abrindo/ }).waitFor({ timeout: WAIT });
    expect(await page.locator('#check-connection').isDisabled()).toBe(true);
    await page.locator('#chrome-state', { hasText: /^Aberto$/ }).waitFor({ timeout: WAIT });
    await page.locator('#check-connection').click();
    await page.locator('#air-state', { hasText: 'Listagem do AIR detectada' }).waitFor({ timeout: WAIT });
    expect(await page.locator('#message').isHidden()).toBe(true);
  }, TIMEOUT);

  it('várias abas: exige escolha explícita e lê a aba escolhida', async () => {
    await start({ root: TREE, pageSize: 30 }, 'root', { extraTabs: ['x'] });
    await openChrome();

    // Com duas abas, nada é lido sem escolher.
    await page.locator('#check-connection').click();
    await page.locator('#message.error', { hasText: 'mais de uma aba' }).waitFor({ timeout: WAIT });
    expect(await page.locator('#tab-field').isVisible()).toBe(true);
    expect(await page.locator('#tab-select option').count()).toBe(3); // aviso + 2 abas
    expect(await text('#air-state')).toBe('Não verificada');

    await page.locator('#tab-select').selectOption('1'); // pasta Alfa (1 filho)
    await page.locator('#check-connection').click();
    await page.locator('#air-state', { hasText: 'Listagem do AIR detectada' }).waitFor({ timeout: WAIT });
    expect(await text('#connection-result')).toContain('Total da pasta: 1');

    await page.locator('#tab-select').selectOption('0'); // Setor (5 filhos)
    await page.locator('#air-state', { hasText: 'Não verificada' }).waitFor({ timeout: WAIT }); // trocar de aba invalida a verificação
    await page.locator('#check-connection').click();
    await page.locator('#air-state', { hasText: 'Listagem do AIR detectada' }).waitFor({ timeout: WAIT });
    expect(await text('#connection-result')).toContain('Total da pasta: 5');
  }, TIMEOUT);

  it('fechar a janela durante a leitura: pede confirmação; "continuar" mantém; "sair" para, preserva o checkpoint e não deixa processo', async () => {
    await start({ root: TREE, pageSize: 30, renderDelayMs: 500 });
    await startSlowTree();

    const stub = (choice: number) => app!.evaluate(({ dialog }, value) => {
      (dialog as unknown as { showMessageBoxSync: () => number }).showMessageBoxSync = () => value;
    }, choice);
    const closeWindow = () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());

    await stub(0);
    await closeWindow();
    expect(await page.title()).toBe('AIR Organizer');
    expect(await page.locator('#op-bar').isVisible()).toBe(true);

    await stub(1);
    const exited = new Promise((resolve) => app!.process().once('exit', resolve));
    await closeWindow();
    await exited;
    app = undefined;
    await expectResumableCheckpoint();

    await launchApp({ root: TREE, pageSize: 30 });
    await resumeToCompletion();
  }, TIMEOUT);

  it('processo encerrado abruptamente (como queda de energia): checkpoint íntegro, sem trava presa, retomada completa', async () => {
    await start({ root: TREE, pageSize: 30, renderDelayMs: 500 });
    await startSlowTree();
    await page.locator('#op-progress', { hasText: /Pastas [2-9]/ }).waitFor({ timeout: WAIT });
    // app.process() é o shell usado pelo Playwright no Windows; o que importa é o processo do Electron.
    const electronPid = await app!.evaluate(() => process.pid);
    const exited = new Promise((resolve) => app!.process().once('exit', resolve));
    process.kill(electronPid, 'SIGKILL');
    await exited;
    app = undefined;
    await expectResumableCheckpoint();

    await launchApp({ root: TREE, pageSize: 30 });
    await resumeToCompletion();
  }, TIMEOUT);

  it('fechar o Chrome à força na parada interrompe, informa e preserva o checkpoint', async () => {
    await start({ root: TREE, pageSize: 30, renderDelayMs: 700 });
    await openChrome();
    await go('Leitura');
    await fill('tree', WIDE);
    await page.locator('#start-tree').click();
    await confirm();
    await page.locator('#op-progress', { hasText: /Pastas [1-9]/ }).waitFor({ timeout: WAIT });
    await page.locator('#op-stop').click();
    await page.locator('#op-force').click();
    await confirm();
    await idle();
    await page.locator('#chrome-state', { hasText: /^Fechado$/ }).waitFor({ state: 'attached', timeout: WAIT });
    const shown = (await text('#tree-result')) + (await page.locator('#message').textContent());
    expect(shown).toMatch(/INTERROMPID|checkpoint/i);
    await expectResumableCheckpoint();
    await resumeToCompletion();
  }, TIMEOUT);
});
