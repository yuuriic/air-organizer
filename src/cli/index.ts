import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { BrowserContext, Page } from 'playwright';
import { resolveInstanceUrl } from './args.js';
import { listVisibleSubfolders, openSubfolder, readFolderContext, returnToParent } from '../air/folders.js';
import { createAirListingSource, detectEnvironment, probePagination, type OperatorContext } from '../air/navigator.js';
import { extractListing, ListingNotFoundError } from '../air/reader.js';
import { httpPages, launchDedicatedChrome } from '../air/session.js';
import { createAirTreeNavigator } from '../air/tree-navigator.js';
import { findDuplicateSuspicions } from '../core/duplicates.js';
import { scanListing } from '../core/scanner.js';
import { formatTreeEvent, scanTree } from '../core/tree-scanner.js';
import { assertReadOnlyMode, fingerprintOf, sanitizeUrl, validateAnalysisScope } from '../safety/scope-validator.js';
import { displayPath, exportInventoryResult, exportTreeResult, newRunId } from '../storage/export.js';
import type { AirEnvironment, Identified, Inventory, TreeLimits } from '../types/inventory.js';

const READ_ONLY = true;
const MAX_PAGES = Number(process.env.AIR_ORGANIZER_MAX_PAGES ?? 500);
const PAGE_TIMEOUT_MS = Number(process.env.AIR_ORGANIZER_PAGE_TIMEOUT_MS ?? 15_000);
const POLL_MS = 300;
const VERBOSE_ERRORS = process.env.AIR_ORGANIZER_VERBOSE_ERRORS === '1';
const INSTANCE_URL = resolveInstanceUrl(process.argv.slice(2), process.env);

const rl = createInterface({ input, output });
const lines = rl[Symbol.asyncIterator]();
let context: BrowserContext | undefined;
let operator: OperatorContext = {};
let lastInventory: Inventory | undefined;

/**
 * Só o status de identificação e a fonte: o valor (domínio, URL, cliente, setor, pasta, caminho)
 * e o motivo da falha (que pode citar nomes) não vão para o console.
 */
function show<T>(field: Identified<T>): string {
  if (field.status === 'not-identified') return 'não identificado';
  const levels = Array.isArray(field.value) ? `, ${field.value.length} nível(is)` : '';
  return `identificado${levels}  [fonte: ${field.source}]`;
}

function printEnvironment(env: AirEnvironment): void {
  console.log('  (valores não exibidos; confira no Chrome dedicado se esta é a pasta autorizada)');
  console.log(`  Instância (origem): ${show(env.instanceOrigin)}`);
  console.log(`  URL (sem query):    ${show(env.pageUrl)}`);
  console.log(`  Cliente:            ${show(env.client)}`);
  console.log(`  Setor:              ${show(env.sector)}`);
  console.log(`  Pasta atual:        ${show(env.currentFolder)}`);
  console.log(`  Caminho:            ${show(env.breadcrumb)}`);
}

class InputClosed extends Error {}

/** Lê uma linha; fim da entrada (Ctrl+D, pipe encerrado) encerra a CLI. */
async function ask(question: string): Promise<string> {
  output.write(question);
  const next = await lines.next();
  if (next.done) throw new InputClosed();
  return next.value.trim();
}

async function confirm(question: string): Promise<boolean> {
  return /^s(im)?$/i.test(await ask(`${question} (s/N) `));
}

/** Abre (uma vez) o Chrome dedicado e devolve a aba do AIR escolhida pelo usuário. */
async function ensurePage(): Promise<Page | undefined> {
  if (!context) {
    console.log('\nAbrindo Chrome com perfil DEDICADO à automação (suas janelas atuais não são afetadas)...');
    context = await launchDedicatedChrome();
    context.on('close', () => {
      context = undefined;
    });
    const url = INSTANCE_URL?.href ?? (await ask('URL inicial do AIR (HTTPS; Enter para abrir em branco): '));
    const page = context.pages()[0] ?? (await context.newPage());
    if (url) {
      sanitizeUrl(url); // valida protocolo/credenciais
      console.log('Abrindo a URL informada (não exibida)...');
      await page.goto(url);
    }
    await ask('Faça login manualmente no Chrome aberto, navegue até a pasta desejada e pressione Enter...');
  }

  const pages = httpPages(context);
  if (pages.length === 0) {
    console.log('Nenhuma aba HTTP(S) aberta no Chrome dedicado.');
    return undefined;
  }
  if (pages.length === 1) return pages[0];
  console.log('Abas abertas no Chrome dedicado:');
  for (const [i, p] of pages.entries()) console.log(`  ${i + 1}. ${await p.title()}`);
  const choice = Number(await ask('Número da aba do AIR: '));
  return pages[choice - 1];
}

async function askOperatorContext(): Promise<void> {
  console.log('\nCliente e setor não têm seletor validado na UI; informe conforme exibido no AIR (Enter = não identificado).');
  const client = await ask(`Cliente/organização${operator.client ? ` [${operator.client}]` : ''}: `);
  const sector = await ask(`Setor selecionado${operator.sector ? ` [${operator.sector}]` : ''}: `);
  operator = { client: client || operator.client, sector: sector || operator.sector };
}

async function checkConnection(): Promise<void> {
  const page = await ensurePage();
  if (!page) return;
  const env = await detectEnvironment(page, operator);
  console.log('\nAmbiente:');
  printEnvironment(env);
  try {
    const listing = await extractListing(page);
    console.log('\nListagem:');
    console.log(`  Colunas:            ${listing.headers.join(' | ')}`);
    console.log(`  Linhas visíveis:    ${listing.rows.length}`);
    console.log(`  Linhas na página:   ${listing.rows.length} (contador da página: ${listing.pageRowCounter ?? 'não identificado'})`);
    console.log(`  Total da pasta:     ${listing.reportedTotal ?? 'não identificado'} (título ${listing.folderTitle ? 'identificado' : 'não identificado'})`);
    console.log(`  Indicador página:   ${listing.pageIndicator ?? 'não identificado'}`);
    const idAttrs = new Set(listing.rows.flatMap((r) => Object.keys(r.idCandidates)));
    console.log(`  Atributos tipo ID:  ${idAttrs.size ? [...idAttrs].join(', ') : 'nenhum'} (não usados até validação manual)`);
  } catch (error) {
    if (!(error instanceof ListingNotFoundError)) throw error;
    console.log(`\n${error.message}`);
  }
  const probe = await probePagination(page);
  const paging =
    probe.status === 'found'
      ? `botão "${probe.label}" ${probe.disabled ? '(desabilitado)' : '(habilitado)'}`
      : probe.status === 'ambiguous'
        ? `ambíguo (${probe.count} controles)`
        : probe.status === 'rejected'
          ? `recusado (${probe.reason})`
          : 'não encontrado (página única ou seletor não suportado)';
  console.log(`  Paginação:          ${paging}`);
}

async function analyzeCurrentFolder(): Promise<void> {
  assertReadOnlyMode(READ_ONLY);
  const page = await ensurePage();
  if (!page) return;
  await askOperatorContext();
  const env = await detectEnvironment(page, operator);
  console.log('\nEscopo da análise (somente leitura, sem entrar em subpastas):');
  printEnvironment(env);
  const problems = validateAnalysisScope(env);
  if (problems.length > 0) {
    console.log('\nAnálise bloqueada:');
    for (const p of problems) console.log(`  - ${p}`);
    return;
  }
  if (!(await confirm('Confirma a análise desta pasta?'))) return;
  await scanAndReport(page, env);
}

/** Lê todas as páginas da pasta exibida, guarda o inventário da sessão e imprime a cobertura. */
async function scanAndReport(page: Page, env: AirEnvironment): Promise<void> {
  const startedAt = new Date().toISOString();
  const source = createAirListingSource(page, fingerprintOf(env), operator, { timeoutMs: PAGE_TIMEOUT_MS, pollMs: POLL_MS });
  const result = await scanListing(source, { maxPages: MAX_PAGES, readTimeoutMs: PAGE_TIMEOUT_MS });
  const duplicateSuspicions = findDuplicateSuspicions(result.items);

  lastInventory = {
    schemaVersion: 1,
    tool: 'air-organizer',
    runId: newRunId(new Date(startedAt)),
    mode: 'current-folder',
    readOnly: true,
    environment: env,
    startedAt,
    finishedAt: new Date().toISOString(),
    coverage: result.coverage,
    items: result.items,
    duplicateSuspicions,
  };

  const c = result.coverage;
  console.log('\nCobertura:');
  console.log(`  Páginas lidas:      ${c.pagesRead}${c.expectedPages !== undefined ? ` de ~${c.expectedPages} (estimado)` : ''}`);
  console.log(`  Itens únicos:       ${c.uniqueItems} (observações: ${c.itemsObserved}, repetidas: ${c.repeatedObservations})`);
  console.log(`  Total da pasta:     ${c.reportedTotal ?? 'não identificado'} (título)`);
  console.log(`  Páginas não lidas:  ${c.unreadPages.length ? c.unreadPages.join(', ') : 'nenhuma conhecida'}`);
  console.log(`  Encerramento:       ${c.stopReason}`);
  console.log(`  Status:             ${c.complete ? 'COMPLETA' : 'PARCIAL'}`);
  // A mensagem pode citar URL, pasta ou breadcrumb; ela fica só no inventário detalhado.
  for (const issue of c.issues) console.log(`  ! [${issue.kind}]${issue.pageNumber !== undefined ? ` página ${issue.pageNumber}` : ''}`);
  const kinds = result.items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {});
  console.log(`  Tipos:              ${Object.entries(kinds).map(([k, n]) => `${k}=${n}`).join(', ') || '-'}`);
  console.log(`  Suspeitas de duplicidade: ${duplicateSuspicions.length} (opção 4)`);
}

/**
 * Ida e volta controlada: lê a pasta atual, abre UMA subpasta escolhida e confirmada,
 * confirma a identidade, lê suas páginas e volta ao pai pelo breadcrumb. Sem recursão.
 */
async function analyzeSubfolder(): Promise<void> {
  assertReadOnlyMode(READ_ONLY);
  const page = await ensurePage();
  if (!page) return;
  const nav = { timeoutMs: PAGE_TIMEOUT_MS, pollMs: POLL_MS };
  const parent = await readFolderContext(page);
  console.log(`\nPasta atual: "${parent.title}" (${parent.total} itens)  caminho: ${parent.path ?? 'não exibido'}`);
  const candidates = await listVisibleSubfolders(page, parent);
  if (candidates.length === 0) {
    console.log('Nenhuma subpasta identificada com segurança nesta página.');
    return;
  }
  console.log('Subpastas visíveis nesta página (nomes exibidos só para a escolha; a opção 3 mostra dados identificáveis):');
  for (const [i, c] of candidates.entries()) console.log(`  ${i + 1}. ${c.name}`);
  const target = candidates[Number(await ask('Número da subpasta: ')) - 1];
  if (!target) return;
  await askOperatorContext();
  if (!(await confirm(`Abrir "${target.name}" (somente leitura) e voltar a "${parent.title}" ao final?`))) return;

  const { child, evidence } = await openSubfolder(page, parent, target, nav);
  console.log(`\nSubpasta confirmada: ${evidence.join('; ')}`);
  const env = await detectEnvironment(page, operator);
  const problems = validateAnalysisScope(env);
  if (problems.length === 0) await scanAndReport(page, env);
  else for (const p of problems) console.log(`  - ${p}`);

  const back = await returnToParent(page, child, parent, nav);
  console.log(`\nRetorno confirmado a "${parent.title}": ${back.evidence.join('; ')}`);
}

/** Por padrão, só referências (D1, D2...), confiança e regras; os nomes exigem confirmação. */
async function showDuplicates(): Promise<void> {
  if (!lastInventory) {
    console.log('\nNenhuma análise realizada nesta sessão. Use a opção 2 primeiro.');
    return;
  }
  const list = lastInventory.duplicateSuspicions;
  console.log(`\nSuspeitas de duplicidade (por nome; NÃO comprovam conteúdo igual): ${list.length}`);
  for (const [i, s] of list.entries()) {
    console.log(`  D${i + 1} [${s.confidence}] ${s.items.length} itens  regras: ${s.matchedBy.join(', ') || 'nomes idênticos'}`);
  }
  if (list.length === 0) return;
  console.log('\nOs nomes dos itens podem conter dados pessoais/sensíveis.');
  if (!(await confirm('Exibir os nomes das suspeitas neste console?'))) return;
  for (const [i, s] of list.entries()) {
    console.log(`\n  D${i + 1} "${s.normalizedName}"`);
    for (const item of s.items) console.log(`    - ${item.name}  (${item.kind}${item.createdAt ? `, criado ${item.createdAt}` : ''})`);
  }
}

/** Mesma política da opção 6: diagnóstico sem nomes por padrão; inventário identificável só com confirmação. */
async function exportLast(): Promise<void> {
  if (!lastInventory) {
    console.log('\nNenhuma análise para exportar. Use a opção 2 primeiro.');
    return;
  }
  console.log('\nO relatório diagnóstico (sem nomes, caminhos nem URLs) é sempre gravado.');
  console.log('O inventário detalhado contém nomes, caminhos e URLs (dados possivelmente pessoais/sensíveis).');
  const detailed = await confirm('Exportar também o inventário detalhado? Somente se permitido pelas políticas da empresa.');
  for (const file of await exportInventoryResult(lastInventory, { detailed })) console.log(`  Gravado: ${displayPath(file)}`);
}

/** Limites conservadores sugeridos para a primeira execução; o usuário confirma cada um. */
const TREE_DEFAULTS: TreeLimits = { maxDepth: 1, maxFolders: 5, maxItems: 100, maxPagesPerFolder: 2 };

async function askLimit(label: string, fallback: number, min: number): Promise<number> {
  for (;;) {
    const raw = await ask(`  ${label} [${fallback}]: `);
    const value = raw === '' ? fallback : Number(raw);
    if (Number.isInteger(value) && value >= min) return value;
    console.log(`  Informe um inteiro >= ${min}.`);
  }
}

/**
 * Leitura recursiva controlada (DFS) a partir da pasta exibida. Por padrão, nada
 * identificável vai para o console: só referências (F1, F2...), contagens e motivos.
 */
async function analyzeTree(): Promise<void> {
  assertReadOnlyMode(READ_ONLY);
  const page = await ensurePage();
  if (!page) return;
  const start = await readFolderContext(page);
  const depth = (start.path ?? '').split('/').filter(Boolean).length;
  console.log('\nPasta inicial = a pasta exibida agora no Chrome dedicado (nome não exibido aqui).');
  console.log(`  ${start.total} filho(s) direto(s); nível ${depth || '?'} da hierarquia. Confira no Chrome se é a pasta autorizada.`);
  await askOperatorContext();
  console.log('\nLimites (Enter mantém o valor conservador):');
  const limits: TreeLimits = {
    maxDepth: await askLimit('Profundidade máxima (0 = só a pasta inicial)', TREE_DEFAULTS.maxDepth, 0),
    maxFolders: await askLimit('Pastas a ler, incluindo a inicial', TREE_DEFAULTS.maxFolders, 1),
    maxItems: await askLimit('Itens a ler no total', TREE_DEFAULTS.maxItems, 1),
    maxPagesPerFolder: await askLimit('Páginas por pasta', TREE_DEFAULTS.maxPagesPerFolder, 1),
  };
  console.log(`
Escopo: a pasta inicial e seus descendentes até ${limits.maxDepth} nível(is) abaixo, nada fora dela.
Limites: ${limits.maxFolders} pasta(s), ${limits.maxItems} itens, ${limits.maxPagesPerFolder} página(s) por pasta. Ao atingir um limite, a leitura para e fica PARCIAL.
Cliques: só próxima página / número da página, nome de subpasta (nunca arquivo) e voltar.
Exportação: relatório diagnóstico SEM nomes; inventário detalhado só se você confirmar ao final.`);
  if (!(await confirm('Confirma a leitura recursiva com esse escopo e esses limites?'))) return;

  const startedAt = new Date().toISOString();
  const nav = createAirTreeNavigator(page, operator, { timeoutMs: PAGE_TIMEOUT_MS, pollMs: POLL_MS, readTimeoutMs: PAGE_TIMEOUT_MS });
  console.log('');
  const result = await scanTree(nav, limits, { onEvent: (e) => console.log(formatTreeEvent(e)) });
  const finishedAt = new Date().toISOString();

  const t = result.totals;
  console.log(`\nResultado: ${result.status.toUpperCase()}`);
  console.log(`  Pastas lidas: ${t.foldersRead}; com pendência na subárvore: ${t.foldersPending}`);
  console.log(`  Itens: ${t.items} (pastas ${t.folders}, arquivos ${t.files}, desconhecidos ${t.unknown})`);
  if (result.limitsReached.length) console.log(`  Limites atingidos: ${result.limitsReached.join(', ')}`);
  if (result.abort) {
    console.log(`  !! Interrompida em ${result.abort.atRef} (${result.abort.reason}). Nenhum clique foi feito depois disso.`);
    console.log('     Verifique no Chrome qual pasta está exibida antes de continuar.');
  }

  const meta = { runId: newRunId(new Date(startedAt)), startedAt, finishedAt, environment: await detectEnvironment(page, operator) };
  console.log('\nO inventário detalhado contém nomes, caminhos e URLs (dados possivelmente pessoais/sensíveis).');
  const detailed = await confirm('Exportar também o inventário detalhado? Somente se permitido pelas políticas da empresa.');
  for (const file of await exportTreeResult(result, meta, { detailed })) console.log(`  Gravado: ${displayPath(file)}`);
}

const MENU = `
AIR Organizer — POC-01 (somente leitura)

1. Verificar conexão com AIR
2. Analisar pasta atual
3. Analisar uma subpasta       (ida e volta, com confirmação; sem recursão)
4. Exibir possíveis duplicidades
5. Exportar inventário
6. Analisar árvore             (recursivo controlado, com limites)
0. Sair
`;

async function main(): Promise<void> {
  for (;;) {
    console.log(MENU);
    let option = '';
    try {
      option = await ask('Opção: ');
      if (option === '0') break;
      else if (option === '1') await checkConnection();
      else if (option === '2') await analyzeCurrentFolder();
      else if (option === '3') await analyzeSubfolder();
      else if (option === '4') await showDuplicates();
      else if (option === '5') await exportLast();
      else if (option === '6') await analyzeTree();
      else console.log('Opção inválida.');
    } catch (error) {
      if (error instanceof InputClosed) break;
      // Mensagens de erro podem citar pastas, caminhos ou URLs. Só a opção 3 (que já exibe
      // nomes) ou AIR_ORGANIZER_VERBOSE_ERRORS=1 mostram o texto; nos demais casos, só o tipo.
      const name = error instanceof Error ? error.name : 'Error';
      const detailed = option === '3' || VERBOSE_ERRORS;
      console.error(`\nErro (${name}): ${detailed ? (error instanceof Error ? error.message : String(error)) : 'detalhes omitidos por poderem conter nomes, caminhos ou URLs.'}`);
      if (!detailed) console.error('  Verifique a pasta exibida no Chrome dedicado. Para ver o texto do erro, defina AIR_ORGANIZER_VERBOSE_ERRORS=1.');
    }
  }
  rl.close();
  await context?.close();
}

await main();
