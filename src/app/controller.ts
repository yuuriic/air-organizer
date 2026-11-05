import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { dedicatedProfileDir, httpPages } from '../air/session.js';
import { FolderIdentityError, listVisibleSubfolders, openSubfolder, readFolderContext, returnToParent, type SubfolderCandidate } from '../air/folders.js';
import { detectEnvironment, type OperatorContext } from '../air/navigator.js';
import { ListingNotFoundError } from '../air/reader.js';
import { resolveInstanceUrl } from '../cli/args.js';
import { ResumeRejectedError, type CheckpointState } from '../core/checkpoint.js';
import { DecisionRefused, createDecisionRecord, latestJustifications, reconcileDecisions, type DecisionSummary } from '../core/movement-decisions.js';
import type { MovementPlan } from '../core/movement-planner.js';
import { redactPlan, type OrganizationPlan, type PlanProposal } from '../core/organization-planner.js';
import { formatFinding, redactReport, type StructuralReport } from '../core/structural-diagnostics.js';
import { formatTreeEvent } from '../core/tree-scanner.js';
import { OpenRefusedError, SafetyViolation, assertReadOnlyMode, validateAnalysisScope } from '../safety/scope-validator.js';
import { InvalidDecisionHistory, appendDecision, decisionsDirectory, loadDecisions, startNewDecisionHistory, type DecisionFileStatus } from '../storage/decision-files.js';
import { CheckpointStore, defaultCheckpointLocations, type CheckpointEntry, type CheckpointSession } from '../storage/checkpoints.js';
import { DEFAULT_OUTPUT_DIR, displayPath, exportInventoryResult, inventoryLabel, newRunId } from '../storage/export.js';
import { openDecisionAuthenticator } from '../storage/integrity-key.js';
import { describeLocalFailure, exportOrganizationPlan, exportStructuralReport, listTreeInventories } from '../storage/inventory-files.js';
import type { Inventory, ResumeMode, TreeInventoryExport, TreeLimits, TreeProgress, TreeResult } from '../types/inventory.js';
import { DedicatedChromeSession, type ChromeStatus } from './connection.js';
import { describePaging, readConnectionSnapshot, readFolderInventory } from './folder-operations.js';
import { COMPLETENESS_LABEL, ELIGIBILITY_LABEL, MODE_LABEL, STATUS_LABEL, coverageLines, describeLimits, integrityLabel, reasonLabel, treeSummaryLines } from './labels.js';
import { diagnoseInventory, inspectInventoryBasis, planInventory, planInventoryMovements } from './local-analysis.js';
import { MAX_SELECTION_NODES, blockingReasonLines, buildSelectionTree, issueCategories, parseDecisionRequest, parseInventoryId, parsePreviewRequest, proposalPreviews, selectionFrom, type PreviewRequest, type ProposalPreview, type SelectionNode, type SelectionTree } from './movement-review.js';
import { operationalConfig } from './runtime.js';
import { applySettings, loadSettings, lockedFields, saveSettings, validateSettings, type SettingField, type Settings } from './settings.js';
import { TREE_DEFAULTS, exportTreeRun, matchResumableRuns, pendingFolders, runTreeScan, type TreeRun } from './tree-run.js';
import { InvalidInput, parseLimits, parseOperator, parseResumeMode } from './validation.js';

/* ───────────── Visões entregues à interface. Por padrão, sem nomes, caminhos nem URLs. ───────────── */

export type AirConnection = 'not-verified' | 'listing-found' | 'listing-not-found';
export type OperationKind = 'connection' | 'folder' | 'subfolder' | 'tree' | 'resume' | 'diagnostics' | 'planning';
export type OperationView = { kind: OperationKind; stopping: boolean; stoppable: boolean; progress?: TreeProgress };
export type AppStatus = { chrome: ChromeStatus; air: AirConnection; operation?: OperationView };
export type AppEvent = { type: 'status'; status: AppStatus } | { type: 'log'; line: string } | { type: 'warning'; text: string };

export type ConnectionView = { air: AirConnection; fields: Array<{ label: string; identified: boolean; detail: string }>; listing: string[]; paging: string };
/** `selected` = -1: nenhuma aba escolhida. */
export type TabsView = { selected: number; tabs: string[] };
export type DuplicateRef = { ref: string; confidence: string; items: number; rules: string };
export type FolderView = { outcome: 'complete' | 'partial'; lines: string[]; duplicates: DuplicateRef[] };
export type SubfoldersView = { total: number; items: Array<{ id: number; name: string }> };
export type TreeRunView = { status: TreeResult['status']; statusLabel: string; stopped: boolean; eligible: boolean; lines: string[]; written: string[]; exportFailed: boolean };
export type ResumeListView = {
  runs: Array<{ id: string; updatedAt: string; state: string; folders: number; items: number; pages: number; pending: number; limits: TreeLimits; limitsText: string; limitsReached: string[] }>;
  mismatched: Array<{ runId: string; message: string }>;
  unavailable: Array<{ runId: string; message: string }>;
  expired: number;
};
export type InventoryListView = Array<{ id: string; label: string; status: string; finishedAt: string }>;
export type DiagnosticView = {
  integrity: string;
  completeness?: string;
  eligibility: string;
  eligibilityStatus: StructuralReport['eligibility']['status'];
  reasons: string[];
  coverage?: StructuralReport['coverage'];
  summary?: StructuralReport['summary'];
  findings: Array<{ id: string; line: string; rule: string; certainty: string; limitations: string[] }>;
  written: string[];
  hasNames: boolean;
};
export type PlanView = {
  accepted: boolean;
  executable: false;
  authorizesChanges: false;
  integrity: string;
  completeness?: string;
  reasons: string[];
  notices: string[];
  summary: OrganizationPlan['summary'];
  proposals: PlanProposal[];
  written: string[];
  hasNames: boolean;
};
/** Sem nomes, caminhos nem URLs: `tree` só tem identificadores e existe só em inventário elegível. */
export type MovementInspectionView = {
  id: string;
  label: string;
  finishedAt: string;
  readMode: string;
  completeness?: string;
  integrity: string;
  eligible: boolean;
  eligibility: string;
  reasons: string[];
  counts?: { folders: number; files: number };
  tree?: SelectionNode[];
};
export type MovementPreviewView = {
  accepted: boolean;
  executable: false;
  authorizesChanges: false;
  reasons: string[];
  notices: string[];
  summary: MovementPlan['summary'];
  categories: { conflicts: Record<string, number>; blockers: Record<string, number> };
  blockingReasons: string[];
  safeOrder: string[];
  proposals: ProposalPreview[];
  decisions: DecisionSummary & { file: DecisionFileStatus };
};
export type NamesView = Array<{ id: string; title: string; folders: Array<{ ref: string; label: string }>; details: string[] }>;
export type SettingsView = {
  values: Settings;
  locked: SettingField[];
  problem?: string;
  file: string;
  paths: { chromeProfile: string; checkpoints: string; output: string };
  defaults: { limits: TreeLimits };
};

/** Falha prevista, com mensagem segura para a tela. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fields?: Partial<Record<string, string>>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export type SafeError = { code: string; message: string; fields?: Partial<Record<string, string>> };

const OPERATION_LABEL: Record<OperationKind, string> = {
  connection: 'Verificação da conexão',
  folder: 'Leitura da pasta atual',
  subfolder: 'Leitura de subpasta',
  tree: 'Leitura de árvore',
  resume: 'Retomada',
  diagnostics: 'Diagnóstico',
  planning: 'Planejamento',
};

export const operationLabel = (kind: OperationKind): string => OPERATION_LABEL[kind];

export type ControllerDeps = {
  launch: () => Promise<BrowserContext>;
  settingsFile: string;
  emit: (event: AppEvent) => void;
  /** Ambiente deste processo, ajustado pelas configurações. Padrão: process.env. */
  env?: Record<string, string | undefined>;
  outputDir?: string;
  /**
   * Confirmação no processo principal para iniciar um novo histórico de decisões: fica fora do alcance
   * da janela, então uma chamada direta ao IPC não a dispensa. Ausente = nunca confirmado.
   */
  confirmDecisionHistoryReset?: () => boolean;
};

/**
 * Orquestra as operações para o aplicativo: uma por vez, sempre somente leitura. Toda regra de
 * negócio fica nos módulos existentes; aqui só há sequência, estado da sessão e visões sem nomes.
 */
export class AppController {
  private readonly env: Record<string, string | undefined>;
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly outputDir: string;
  private readonly chrome: DedicatedChromeSession<BrowserContext>;
  private air: AirConnection = 'not-verified';
  private operation: (OperationView & { abort: AbortController; done: Promise<unknown> }) | undefined;
  private settings: Settings = {};
  private settingsProblem: string | undefined;
  private store: CheckpointStore | undefined;
  private operator: OperatorContext = {};
  private selectedTab: Page | undefined;
  private listedTabs: Page[] = [];
  private lastInventory: Inventory | undefined;
  private subfolders: SubfolderCandidate[] = [];
  private lastRun: TreeRun | undefined;
  private inventories = new Map<string, string>();
  private resumable = new Map<string, CheckpointEntry>();
  private lastReport: { report: StructuralReport; file: string } | undefined;
  private lastPlan: { plan: OrganizationPlan; file: string } | undefined;
  /** Inventário aberto para seleção. Os nomes ficam aqui, no processo principal, e só em memória. */
  private selection: { inventoryId: string; authenticatedId: string; tree: SelectionTree } | undefined;

  constructor(private readonly deps: ControllerDeps) {
    this.env = deps.env ?? process.env;
    this.baseEnv = { ...this.env };
    this.outputDir = deps.outputDir ?? DEFAULT_OUTPUT_DIR;
    this.chrome = new DedicatedChromeSession(() => this.launchAndNavigate(), () => {
      if (this.chrome.status.state !== 'open') {
        this.air = 'not-verified';
        this.selectedTab = undefined;
        this.listedTabs = [];
      }
      this.emitStatus();
    });
  }

  async init(): Promise<void> {
    const { settings, problem } = await loadSettings(this.deps.settingsFile);
    this.settings = settings;
    this.settingsProblem = problem;
    applySettings(this.env, this.baseEnv, settings);
  }

  status(): AppStatus {
    const op = this.operation;
    return {
      chrome: this.chrome.status,
      air: this.air,
      ...(op ? { operation: { kind: op.kind, stopping: op.stopping, stoppable: op.stoppable, ...(op.progress ? { progress: op.progress } : {}) } } : {}),
    };
  }

  private emitStatus(): void {
    this.deps.emit({ type: 'status', status: this.status() });
  }

  private config() {
    return operationalConfig(this.env);
  }

  private locations() {
    return defaultCheckpointLocations(this.env);
  }

  /** Uma operação por vez. Sem isso, duas leituras disputariam a mesma aba. */
  private exclusive<T>(kind: OperationKind, action: (signal: AbortSignal) => Promise<T>, stoppable = false): Promise<T> {
    if (this.operation) throw new AppError('busy', `${OPERATION_LABEL[this.operation.kind]} em andamento. Aguarde ou interrompa.`);
    const abort = new AbortController();
    const done = action(abort.signal).finally(() => {
      this.operation = undefined;
      this.emitStatus();
    });
    this.operation = { kind, stopping: false, stoppable, abort, done: done.catch(() => {}) };
    this.emitStatus();
    return done;
  }

  /* ───────────── Chrome e conexão ───────────── */

  /**
   * A sessão só fica "aberta" depois da navegação inicial: antes disso a aba ainda não é HTTP(S) e
   * qualquer ação pareceria falhar por não haver aba do AIR. Falha de navegação não fecha o Chrome.
   */
  private async launchAndNavigate(): Promise<BrowserContext> {
    const url = resolveInstanceUrl([], this.env);
    const context = await this.deps.launch();
    if (!url) return context;
    let closed = false;
    context.once('close', () => {
      closed = true;
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url.href, { timeout: this.config().pageTimeoutMs }).catch(() => {
      if (!closed) this.deps.emit({ type: 'warning', text: 'Não foi possível abrir a URL configurada. Navegue manualmente no Chrome dedicado.' });
    });
    if (closed) throw new Error('O Chrome dedicado foi fechado durante a abertura.');
    return context;
  }

  /** Abre o Chrome dedicado; se houver URL configurada, navega até ela. O login é sempre manual. */
  async openChrome(): Promise<AppStatus> {
    resolveInstanceUrl([], this.env); // URL inválida é recusada antes de abrir qualquer coisa
    await this.chrome.open();
    return this.status();
  }

  /** Fechamento normal: nunca durante uma operação. Para interromper, use a parada controlada. */
  async closeChrome(): Promise<AppStatus> {
    if (this.operation) throw new AppError('busy', 'Há uma operação em andamento. Use "Interromper leitura" e aguarde.');
    await this.chrome.close();
    return this.status();
  }

  /** Só para recuperação: leitura travada que não atende à parada. O checkpoint gravado é preservado. */
  async forceCloseChrome(): Promise<AppStatus> {
    this.operation?.abort.abort();
    await this.chrome.close();
    return this.status();
  }

  private requireContext(): BrowserContext {
    const context = this.chrome.context;
    if (!context || this.chrome.status.state !== 'open') throw new AppError('chrome-closed', 'Abra o Chrome dedicado primeiro.');
    return context;
  }

  async listTabs(): Promise<TabsView> {
    this.listedTabs = httpPages(this.requireContext());
    return { selected: this.selectedTab ? this.listedTabs.indexOf(this.selectedTab) : -1, tabs: await Promise.all(this.listedTabs.map((p) => p.title().catch(() => '(sem título)'))) };
  }

  selectTab(input: unknown): void {
    this.requireContext();
    const page = typeof input === 'number' ? this.listedTabs[input] : undefined;
    if (!page || page.isClosed()) throw new InvalidInput('Aba inválida. Verifique a conexão para atualizar a lista.');
    this.selectedTab = page;
    this.air = 'not-verified';
    this.emitStatus();
  }

  private requirePage(): Page {
    const pages = httpPages(this.requireContext());
    // A aba é o objeto escolhido, não uma posição: fechar outra aba não troca a pasta lida.
    if (this.selectedTab && pages.includes(this.selectedTab)) return this.selectedTab;
    if (pages.length === 1) return pages[0]!;
    if (pages.length === 0) throw new AppError('no-tab', 'Nenhuma aba HTTP(S) aberta no Chrome dedicado. Navegue até o AIR e faça login.');
    throw new AppError('tab-required', 'Há mais de uma aba aberta no Chrome dedicado. Em Início, escolha a aba do AIR.');
  }

  checkConnection(input: unknown): Promise<ConnectionView> {
    return this.exclusive('connection', async () => {
      this.operator = parseOperator(input, this.operator);
      const snapshot = await readConnectionSnapshot(this.requirePage(), this.operator);
      this.air = snapshot.listing ? 'listing-found' : 'listing-not-found';
      const env = snapshot.environment;
      const field = (label: string, value: { status: string; source?: string; value?: unknown }) => ({
        label,
        identified: value.status === 'identified',
        // Só o status e a fonte: os valores podem identificar pessoas e ficam visíveis no próprio Chrome.
        detail: value.status === 'identified' ? `identificado · ${Array.isArray(value.value) ? `${value.value.length} nível(is) · ` : ''}fonte: ${value.source}` : 'não identificado',
      });
      const l = snapshot.listing;
      return {
        air: this.air,
        fields: [
          field('Instância (origem)', env.instanceOrigin),
          field('URL (sem query)', env.pageUrl),
          field('Cliente', env.client),
          field('Setor', env.sector),
          field('Pasta atual', env.currentFolder),
          field('Caminho', env.breadcrumb),
        ],
        listing: l
          ? [
              `Colunas: ${l.headers.join(' | ')}`,
              `Linhas na página: ${l.rows} (contador da página: ${l.pageRowCounter ?? 'não identificado'})`,
              `Total da pasta: ${l.reportedTotal ?? 'não identificado'} (título ${l.titleIdentified ? 'identificado' : 'não identificado'})`,
              `Indicador de página: ${l.pageIndicator ?? 'não identificado'}`,
            ]
          : ['Nenhuma listagem do AIR reconhecida nesta aba. Faça login e abra uma pasta.'],
        paging: describePaging(snapshot.paging),
      };
    });
  }

  /* ───────────── Pasta atual e subpasta ───────────── */

  private folderView(inventory: Inventory): FolderView {
    return {
      outcome: inventory.coverage.complete ? 'complete' : 'partial',
      lines: coverageLines(inventory).map((l) => l.trim()),
      duplicates: inventory.duplicateSuspicions.map((s, i) => ({ ref: `D${i + 1}`, confidence: s.confidence, items: s.items.length, rules: s.matchedBy.join(', ') || 'nomes idênticos' })),
    };
  }

  readCurrentFolder(input: unknown): Promise<FolderView> {
    return this.exclusive('folder', async () => {
      assertReadOnlyMode(true);
      this.operator = parseOperator(input, this.operator);
      const page = this.requirePage();
      const env = await detectEnvironment(page, this.operator);
      const problems = validateAnalysisScope(env);
      if (problems.length > 0) throw new AppError('scope-blocked', `Análise bloqueada: ${problems.join(' ')}`);
      this.lastInventory = await readFolderInventory(page, env, this.operator, this.config());
      return this.folderView(this.lastInventory);
    });
  }

  listSubfolders(): Promise<SubfoldersView> {
    return this.exclusive('subfolder', async () => {
      const page = this.requirePage();
      const parent = await readFolderContext(page);
      this.subfolders = await listVisibleSubfolders(page, parent);
      return { total: parent.total, items: this.subfolders.map((c, id) => ({ id, name: c.name })) };
    });
  }

  /** Ida e volta controlada, com identidade confirmada nos dois sentidos e sem recursão. */
  readSubfolder(input: unknown): Promise<FolderView> {
    return this.exclusive('subfolder', async () => {
      assertReadOnlyMode(true);
      const arg = (input ?? {}) as { id?: unknown; operator?: unknown };
      const target = typeof arg.id === 'number' ? this.subfolders[arg.id] : undefined;
      if (!target) throw new InvalidInput('Subpasta inválida. Liste as subpastas de novo.');
      this.subfolders = [];
      this.operator = parseOperator(arg.operator, this.operator);
      const page = this.requirePage();
      const config = this.config();
      const nav = { timeoutMs: config.pageTimeoutMs, pollMs: config.pollMs };
      const parent = await readFolderContext(page);
      const { child } = await openSubfolder(page, parent, target, nav);
      const env = await detectEnvironment(page, this.operator);
      const problems = validateAnalysisScope(env);
      let view: FolderView | undefined;
      if (problems.length === 0) {
        this.lastInventory = await readFolderInventory(page, env, this.operator, config);
        view = this.folderView(this.lastInventory);
      }
      await returnToParent(page, child, parent, nav);
      if (!view) throw new AppError('scope-blocked', `Análise bloqueada: ${problems.join(' ')} A pasta anterior foi restaurada.`);
      return view;
    });
  }

  /** Exige ação explícita na tela: nomes podem conter dados pessoais. */
  revealDuplicates(): NamesView {
    if (!this.lastInventory) throw new AppError('no-result', 'Nenhuma análise realizada nesta sessão.');
    return this.lastInventory.duplicateSuspicions.map((s, i) => ({
      id: `D${i + 1}`,
      title: s.normalizedName,
      folders: s.items.map((item, n) => ({ ref: String(n + 1), label: `${item.name} (${item.kind}${item.createdAt ? `, criado ${item.createdAt}` : ''})` })),
      details: [],
    }));
  }

  async exportFolder(input: unknown): Promise<string[]> {
    if (!this.lastInventory) throw new AppError('no-result', 'Nenhuma análise para exportar.');
    const detailed = (input as { detailed?: unknown } | undefined)?.detailed === true;
    return (await exportInventoryResult(this.lastInventory, { detailed }, this.outputDir)).map((f) => displayPath(f, this.outputDir));
  }

  /* ───────────── Leitura recursiva, parada controlada e retomada ───────────── */

  private async checkpointStore(): Promise<CheckpointStore> {
    this.store ??= await CheckpointStore.open({ ...this.locations(), retentionDays: this.config().retentionDays });
    return this.store;
  }

  private async finishRun(page: Page, limits: TreeLimits, session: CheckpointSession, signal: AbortSignal, resume?: { from: NonNullable<CheckpointEntry['checkpoint']>['folders']; mode: ResumeMode }): Promise<TreeRunView> {
    const store = await this.checkpointStore();
    const log = (line: string) => this.deps.emit({ type: 'log', line });
    log(`[${STATUS_LABEL.running}] execução ${session.runId}${resume ? ` · retomada ${MODE_LABEL[resume.mode]}` : ' · nova execução'}; limites: ${describeLimits(limits)}`);
    const run = await runTreeScan({
      page,
      operator: this.operator,
      limits,
      session,
      pseudonymize: store.pseudonymize,
      ...(resume ? { resume } : {}),
      config: this.config(),
      signal,
      onEvent: (event) => {
        if (event.type === 'progress' && event.progress && this.operation) {
          this.operation.progress = event.progress;
          this.emitStatus();
        } else {
          log(formatTreeEvent(event));
        }
      },
      onCheckpointFailure: (name) => log(`! checkpoint não gravado (${name}); a retomada pode repetir trabalho.`),
    });
    this.lastRun = run;
    const { result } = run;
    let written: string[] = [];
    let exportFailed = false;
    try {
      written = (await exportTreeRun(run, store, { detailed: false, outputDir: this.outputDir })).map((f) => displayPath(f, this.outputDir));
    } catch {
      exportFailed = true;
    }
    return {
      status: result.status,
      statusLabel: STATUS_LABEL[result.status as CheckpointState],
      stopped: result.stopped === true,
      eligible: result.verification.eligibleForPlanning,
      lines: treeSummaryLines(result, limits, run.checkpointFailures, '"Retomar"').map((l) => l.trim()),
      written,
      exportFailed,
    };
  }

  startTree(input: unknown): Promise<TreeRunView> {
    return this.exclusive(
      'tree',
      async (signal) => {
        assertReadOnlyMode(true);
        const arg = (input ?? {}) as { limits?: unknown; operator?: unknown };
        const limits = parseLimits(arg.limits);
        this.operator = parseOperator(arg.operator, this.operator);
        const page = this.requirePage();
        await readFolderContext(page); // falha fechada antes de criar checkpoint: a pasta exibida precisa ser confirmável
        const store = await this.checkpointStore();
        const scope = store.scopeOf(await detectEnvironment(page, this.operator));
        if (!scope) throw new AppError('scope-unidentified', 'Origem ou URL da pasta não identificadas: a execução não pode ser vinculada a um checkpoint. Leitura cancelada.');
        const session = await store.create(scope, newRunId(), limits);
        return this.finishRun(page, limits, session, signal);
      },
      true,
    );
  }

  /** Parada controlada: termina a página em leitura, não abre mais nada e volta à pasta inicial. */
  stopOperation(): AppStatus {
    const op = this.operation;
    if (op?.stoppable && !op.stopping) {
      op.stopping = true;
      op.abort.abort();
      this.emitStatus();
    }
    return this.status();
  }

  async exportTreeDetailed(): Promise<string[]> {
    if (!this.lastRun) throw new AppError('no-result', 'Nenhuma leitura de árvore para exportar.');
    const written = await exportTreeRun(this.lastRun, await this.checkpointStore(), { detailed: true, outputDir: this.outputDir });
    return written.map((f) => displayPath(f, this.outputDir));
  }

  /** Execuções gravadas, sem criar a chave local quando ainda não há nenhum checkpoint. */
  private async checkpointEntries(): Promise<CheckpointEntry[]> {
    const { keyFile, dir } = this.locations();
    if (!existsSync(keyFile) || !existsSync(dir)) return [];
    return (await this.checkpointStore()).list();
  }

  listResumable(input: unknown): Promise<ResumeListView> {
    return this.exclusive('resume', async () => {
      this.operator = parseOperator(input, this.operator);
      const entries = await this.checkpointEntries();
      const page = this.requirePage();
      this.resumable.clear();
      const base = {
        expired: entries.filter((e) => e.rejection?.code === 'expired').length,
        unavailable: entries.filter((e) => e.rejection && e.rejection.code !== 'expired' && e.rejection.code !== 'finished').map((e) => ({ runId: e.runId, message: e.rejection!.message })),
      };
      if (entries.every((e) => e.rejection)) return { runs: [], mismatched: [], ...base };
      const store = await this.checkpointStore();
      const scope = store.scopeOf(await detectEnvironment(page, this.operator));
      if (!scope) throw new AppError('scope-unidentified', 'Origem ou URL da pasta não identificadas; retomada recusada.');
      const { matching, mismatched } = matchResumableRuns(entries, scope);
      for (const entry of matching) this.resumable.set(entry.runId, entry);
      return {
        runs: matching.map((entry) => {
          const cp = entry.checkpoint!;
          return {
            id: entry.runId,
            updatedAt: cp.updatedAt,
            state: cp.state === 'running' ? 'interrompida' : STATUS_LABEL[cp.state].toLowerCase(),
            folders: cp.totals.foldersRead,
            items: cp.totals.items,
            pages: cp.totals.pagesRead,
            pending: pendingFolders(cp),
            limits: cp.limits,
            limitsText: describeLimits(cp.limits),
            limitsReached: cp.limitsReached,
          };
        }),
        mismatched,
        ...base,
      };
    });
  }

  resumeTree(input: unknown): Promise<TreeRunView> {
    return this.exclusive(
      'resume',
      async (signal) => {
        assertReadOnlyMode(true);
        const arg = (input ?? {}) as { id?: unknown; mode?: unknown; limits?: unknown; operator?: unknown };
        const entry = typeof arg.id === 'string' ? this.resumable.get(arg.id) : undefined;
        if (!entry) throw new InvalidInput('Execução inválida. Busque as execuções de novo.');
        const mode = parseResumeMode(arg.mode);
        const limits = parseLimits(arg.limits);
        this.operator = parseOperator(arg.operator, this.operator);
        const page = this.requirePage();
        const store = await this.checkpointStore();
        const scope = store.scopeOf(await detectEnvironment(page, this.operator));
        if (!scope) throw new AppError('scope-unidentified', 'Origem ou URL da pasta não identificadas; retomada recusada.');
        const { session, checkpoint } = await store.resume(entry, scope, limits, mode);
        this.resumable.clear();
        return this.finishRun(page, limits, session, signal, { from: checkpoint.folders, mode });
      },
      true,
    );
  }

  /* ───────────── Diagnóstico e planejamento (locais, sem navegador) ───────────── */

  async listInventories(): Promise<InventoryListView> {
    const found = await listTreeInventories(this.outputDir);
    // Identificador estável: um arquivo novo na lista não faz um identificador antigo apontar para outro inventário.
    const idOf = (file: string) => `inv-${createHash('sha256').update(file, 'utf8').digest('hex').slice(0, 16)}`;
    this.inventories = new Map(found.map((entry) => [idOf(entry.file), entry.file]));
    return found.map((entry) => ({ id: idOf(entry.file), label: inventoryLabel(entry.file, this.outputDir), status: entry.status ?? '?', finishedAt: entry.finishedAt ?? '?' }));
  }

  /** A interface só conhece identificadores; o caminho nunca vem dela. */
  private inventoryFile(input: unknown): string {
    const file = typeof input === 'string' ? this.inventories.get(input) : undefined;
    if (!file) throw new InvalidInput('Inventário inválido. Atualize a lista.');
    return file;
  }

  private localOptions() {
    return { keyFile: this.locations().keyFile, maxAgeDays: this.config().inventoryMaxAgeDays, outputDir: this.outputDir };
  }

  diagnose(input: unknown): Promise<DiagnosticView> {
    return this.exclusive('diagnostics', async () => {
      const file = this.inventoryFile(input);
      const { report, keyUnavailable } = await diagnoseInventory(file, this.localOptions());
      this.lastReport = { report, file };
      const k = report.completeness;
      const rejected = report.eligibility.status === 'rejected';
      const redacted = redactReport(report);
      return {
        integrity: integrityLabel(report, keyUnavailable),
        ...(k
          ? {
              completeness: `${COMPLETENESS_LABEL[k.status]} · ${k.contentRevalidated === undefined ? 'revalidação não informada (formato antigo)' : k.contentRevalidated ? 'conteúdo lido na sessão' : 'conteúdo NÃO revalidado'}${k.resumeMode ? ` · retomada ${MODE_LABEL[k.resumeMode]}` : ''}`,
            }
          : {}),
        eligibility: ELIGIBILITY_LABEL[report.eligibility.status],
        eligibilityStatus: report.eligibility.status,
        reasons: report.eligibility.reasons.map(String).map(reasonLabel),
        ...(rejected ? {} : { coverage: report.coverage, summary: report.summary }),
        findings: redacted.findings.map((f) => ({ id: f.id, line: formatFinding(f), rule: f.rule, certainty: f.certainty, limitations: f.limitations })),
        // Inventário recusado não produz relatório gravado, como na CLI.
        written: rejected ? [] : (await exportStructuralReport(report, file, { detailed: false }, this.outputDir)).map((f) => displayPath(f, this.outputDir)),
        hasNames: report.findings.length > 0,
      };
    });
  }

  revealDiagnosticNames(): NamesView {
    if (!this.lastReport) throw new AppError('no-result', 'Nenhum diagnóstico nesta sessão.');
    return this.lastReport.report.findings.map((f) => ({
      id: f.id,
      title: f.rule,
      folders: f.folders.map((e) => ({ ref: e.ref, label: e.path ?? e.name ?? '(sem nome no inventário)' })),
      details: [
        ...(f.names?.variants ? [`Grafias: ${f.names.variants.map((v) => JSON.stringify(v)).join(' · ')}`] : []),
        ...(f.names?.common ? [`Em comum: ${f.names.common.join(' · ')}`] : []),
        ...Object.entries(f.names?.onlyIn ?? {}).map(([ref, names]) => `Só em ${ref}: ${names.join(' · ') || '-'}`),
      ],
    }));
  }

  async exportDiagnosticDetailed(): Promise<string[]> {
    if (!this.lastReport) throw new AppError('no-result', 'Nenhum diagnóstico nesta sessão.');
    if (this.lastReport.report.eligibility.status === 'rejected') throw new AppError('refused', 'Inventário recusado não gera relatório.');
    return (await exportStructuralReport(this.lastReport.report, this.lastReport.file, { detailed: true }, this.outputDir)).map((f) => displayPath(f, this.outputDir));
  }

  plan(input: unknown): Promise<PlanView> {
    return this.exclusive('planning', async () => {
      const file = this.inventoryFile(input);
      const { plan, keyUnavailable } = await planInventory(file, this.localOptions());
      this.lastPlan = { plan, file };
      const v = plan.validation;
      const accepted = v.status === 'accepted';
      return {
        accepted,
        executable: plan.executable,
        authorizesChanges: plan.authorizesChanges,
        integrity: integrityLabel(v, keyUnavailable),
        ...(v.completeness ? { completeness: `${COMPLETENESS_LABEL[v.completeness.status]}${v.completeness.resumeMode ? ` · retomada ${MODE_LABEL[v.completeness.resumeMode]}` : ''}` } : {}),
        reasons: v.reasons.map(reasonLabel),
        notices: plan.notices,
        summary: plan.summary,
        proposals: redactPlan(plan).proposals,
        // Plano recusado não é gravado.
        written: accepted ? (await exportOrganizationPlan(plan, file, { detailed: false }, this.outputDir)).map((f) => displayPath(f, this.outputDir)) : [],
        hasNames: plan.proposals.length > 0,
      };
    });
  }

  revealPlanNames(): NamesView {
    if (!this.lastPlan) throw new AppError('no-result', 'Nenhum plano nesta sessão.');
    return this.lastPlan.plan.proposals.map((p) => ({
      id: p.id,
      title: p.kind,
      folders: p.observed.folders.map((e) => ({ ref: e.ref, label: e.path ?? e.name ?? '(sem nome no inventário)' })),
      details: [
        ...(p.observed.names?.variants ? [`Grafias: ${p.observed.names.variants.map((x) => JSON.stringify(x)).join(' · ')}`] : []),
        ...(p.futureAction?.hypothesisName !== undefined ? [`Hipótese (não oficial): ${JSON.stringify(p.futureAction.hypothesisName)}`] : []),
      ],
    }));
  }

  async exportPlanDetailed(): Promise<string[]> {
    if (!this.lastPlan) throw new AppError('no-result', 'Nenhum plano nesta sessão.');
    return (await exportOrganizationPlan(this.lastPlan.plan, this.lastPlan.file, { detailed: true }, this.outputDir)).map((f) => displayPath(f, this.outputDir));
  }

  /* ───────────── Prévia e revisão de movimentações (POC-03B): nada é executado no AIR ───────────── */

  /** Elegibilidade pelo critério do planejamento. Só inventário elegível abre a seleção. */
  inspectInventory(input: unknown): Promise<MovementInspectionView> {
    return this.exclusive('planning', async () => {
      this.selection = undefined;
      const inventoryId = parseInventoryId(input);
      const file = this.inventoryFile(inventoryId);
      const { input: doc, plan, keyUnavailable } = await inspectInventoryBasis(file, this.localOptions());
      const v = plan.validation;
      const eligible = v.status === 'accepted' && plan.source.inventoryId !== undefined;
      // Documento recusado na estrutura não é confiável nem para contar.
      const inv = v.eligibility.status === 'rejected' ? undefined : (doc as TreeInventoryExport);
      const tree = eligible ? buildSelectionTree(inv!) : undefined;
      if (tree && tree.nodes.length > MAX_SELECTION_NODES) throw new AppError('inventory-too-large', 'Este inventário tem itens demais para a seleção nesta tela.');
      if (tree) this.selection = { inventoryId, authenticatedId: plan.source.inventoryId!, tree };
      return {
        id: inventoryId,
        label: inventoryLabel(file, this.outputDir),
        finishedAt: inv?.finishedAt ?? '?',
        readMode: !inv ? 'não informado' : inv.resume ? `retomada ${MODE_LABEL[inv.resume.mode]}` : 'leitura direta, sem retomada',
        ...(v.completeness ? { completeness: COMPLETENESS_LABEL[v.completeness.status] } : {}),
        integrity: integrityLabel(v, keyUnavailable),
        eligible,
        eligibility: eligible ? ELIGIBILITY_LABEL['planning-eligible'] : 'NÃO ELEGÍVEL: este inventário não pode gerar propostas de movimentação.',
        reasons: v.reasons.map(reasonLabel),
        ...(inv ? { counts: { folders: inv.folders.length, files: inv.folders.reduce((sum, f) => sum + f.items.filter((i) => i.kind === 'file').length, 0) } } : {}),
        ...(tree ? { tree: tree.nodes } : {}),
      };
    });
  }

  /** Só o inventário aberto para seleção: identificadores de um nunca valem para outro. */
  private openSelection(inventoryId: unknown) {
    if (!this.selection || this.selection.inventoryId !== inventoryId) throw new InvalidInput('Analise este inventário antes de selecionar a origem e o destino.');
    return this.selection;
  }

  /** Só depois de ação explícita na janela. Identificador → nome; não é registrado nem persistido. */
  revealSelectionNames(input: unknown): Record<string, string> {
    return this.openSelection(parseInventoryId(input)).tree.names;
  }

  previewProposals(input: unknown): Promise<MovementPreviewView> {
    return this.exclusive('planning', async () => {
      const request = parsePreviewRequest(input);
      return this.previewView(request, await this.currentPlan(request));
    });
  }

  /**
   * Registra uma decisão humana. Só revisão local: nada é executado nem autorizado. O plano é refeito
   * aqui, a partir do inventário: nada do que a janela diga sobre a proposta é levado em conta.
   */
  decideProposal(input: unknown): Promise<MovementPreviewView> {
    return this.exclusive('planning', async () => {
      const { selection, proposalId, decision, justification } = parseDecisionRequest(input);
      const plan = await this.currentPlan(selection);
      if (plan.validation.status !== 'accepted') throw new AppError('inventory-not-eligible', 'Este inventário não está elegível agora: nenhuma decisão foi registrada.');
      const proposal = plan.proposals.find((p) => p.id === proposalId);
      if (!proposal) throw new AppError('proposal-not-found', 'Esta proposta não faz parte da seleção atual. Gere a prévia de novo.');
      const auth = await this.decisionAuthenticator();
      const now = new Date();
      try {
        await appendDecision(this.decisionsDir(), createDecisionRecord(plan, proposal, decision, justification, now, auth), auth);
      } catch (error) {
        if (error instanceof InvalidDecisionHistory) throw new AppError('decision-history-invalid', 'O histórico local de decisões deste inventário é inválido: nenhuma decisão foi registrada. Inicie um novo histórico para continuar.');
        if (error instanceof DecisionRefused) throw new AppError('decision-refused', error.message);
        if (error instanceof RangeError) throw new AppError('decisions-too-large', 'O histórico de decisões deste inventário atingiu o limite local. Nenhuma decisão foi registrada.');
        throw error;
      }
      return this.previewView(selection, plan);
    });
  }

  /** Justificativas podem conter nomes digitados pelo operador: saem só junto com a revelação de nomes. */
  async revealDecisionNotes(input: unknown): Promise<Record<string, string>> {
    const selection = this.openSelection(parseInventoryId(input));
    const { records } = await loadDecisions(this.decisionsDir(), selection.authenticatedId, await this.decisionAuthenticator());
    return latestJustifications(records);
  }

  /**
   * Histórico inválido: só com a confirmação do processo principal, guarda o arquivo como cópia e começa
   * um novo, sem importar nada dele. Histórico válido ou ausente não passa por aqui nem pede confirmação.
   */
  resetDecisionHistory(input: unknown): Promise<{ outcome: 'reset' | 'cancelled' }> {
    return this.exclusive('planning', async () => {
      const { authenticatedId } = this.openSelection(parseInventoryId(input));
      const auth = await this.decisionAuthenticator();
      const { status } = await loadDecisions(this.decisionsDir(), authenticatedId, auth);
      if (status !== 'invalid') throw new AppError('decision-history-not-invalid', 'O histórico deste inventário não está inválido: nada foi alterado.');
      if (!this.deps.confirmDecisionHistoryReset?.()) return { outcome: 'cancelled' as const };
      await startNewDecisionHistory(this.decisionsDir(), authenticatedId, auth, new Date());
      return { outcome: 'reset' as const };
    });
  }

  private decisionsDir(): string {
    return decisionsDirectory(this.locations().keyFile);
  }

  private async decisionAuthenticator() {
    const auth = await openDecisionAuthenticator(this.locations().keyFile);
    if (!auth) throw new AppError('decisions-unavailable', 'A chave local não está disponível: as decisões não podem ser conferidas nem registradas.');
    return auth;
  }

  /** O motor relê e revalida o inventário; os identificadores só valem para o arquivo em que foram criados. */
  private async currentPlan(request: PreviewRequest): Promise<MovementPlan> {
    const selection = this.openSelection(request.inventoryId);
    const movement = selectionFrom(selection.tree, request);
    const { plan } = await planInventoryMovements(this.inventoryFile(request.inventoryId), { selections: [movement] }, this.localOptions());
    if (plan.validation.status === 'accepted' && plan.source.inventoryId !== selection.authenticatedId) {
      this.selection = undefined;
      throw new AppError('inventory-changed', 'O inventário mudou desde a análise. Analise-o de novo antes de selecionar.');
    }
    return plan;
  }

  private async previewView(request: PreviewRequest, plan: MovementPlan): Promise<MovementPreviewView> {
    const selection = this.openSelection(request.inventoryId);
    const accepted = plan.validation.status === 'accepted';
    const auth = accepted ? await this.decisionAuthenticator() : undefined;
    const loaded = auth ? await loadDecisions(this.decisionsDir(), selection.authenticatedId, auth) : { status: 'absent' as const, records: [] };
    const { states, summary } = auth ? reconcileDecisions(plan, loaded.records, auth) : { states: new Map(), summary: { approved: 0, rejected: 0, pending: 0, notApprovable: 0, invalidated: 0 } };
    return {
      accepted,
      executable: plan.executable,
      authorizesChanges: plan.authorizesChanges,
      reasons: plan.validation.reasons.map(reasonLabel),
      notices: plan.notices,
      summary: plan.summary,
      categories: issueCategories(plan),
      blockingReasons: blockingReasonLines(plan),
      safeOrder: plan.safeOrder,
      proposals: proposalPreviews(plan, selection.tree, states),
      decisions: { ...summary, file: loaded.status },
    };
  }

  /* ───────────── Configurações ───────────── */

  getSettings(): SettingsView {
    let chromeProfile = 'Diretório configurado não é permitido';
    try {
      chromeProfile = dedicatedProfileDir();
    } catch {
      // mostra o aviso acima
    }
    return {
      values: this.settings,
      locked: lockedFields(this.baseEnv),
      ...(this.settingsProblem ? { problem: this.settingsProblem } : {}),
      file: this.deps.settingsFile,
      paths: { chromeProfile, checkpoints: this.locations().dir, output: path.resolve(this.outputDir) },
      defaults: { limits: TREE_DEFAULTS },
    };
  }

  /** Só com tudo parado: perfil e checkpoints não mudam com o Chrome aberto ou uma leitura em andamento. */
  async saveSettings(input: unknown): Promise<SettingsView> {
    if (this.operation || this.chrome.status.state !== 'closed') throw new AppError('busy', 'Feche o Chrome dedicado e aguarde as operações para salvar as configurações.');
    const { settings, errors } = validateSettings(input);
    if (Object.keys(errors).length > 0) throw new AppError('invalid-settings', 'Corrija os campos indicados.', errors);
    await saveSettings(this.deps.settingsFile, settings);
    this.settings = settings;
    this.settingsProblem = undefined;
    this.store = undefined;
    applySettings(this.env, this.baseEnv, settings);
    return this.getSettings();
  }

  /* ───────────── Encerramento e erros ───────────── */

  get busy(): boolean {
    return this.operation !== undefined;
  }

  /** Pede a parada, espera a leitura terminar (com prazo) e fecha o Chrome. O checkpoint fica preservado. */
  async shutdown(timeoutMs = 30_000): Promise<void> {
    const op = this.operation;
    if (op) {
      op.stopping = true;
      op.abort.abort();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([op.done, new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
      clearTimeout(timer);
    }
    await this.chrome.close();
  }

  /** Mensagem segura: mensagens originais podem citar pastas, caminhos ou URLs. */
  describeError(error: unknown): SafeError {
    const verbose = this.config().verboseErrors && error instanceof Error ? ` (${error.name}: ${error.message})` : '';
    if (error instanceof AppError) return { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) };
    if (error instanceof InvalidInput) return { code: 'invalid-input', message: error.message };
    // Motivos de recusa da retomada não contêm nomes, caminhos nem URLs.
    if (error instanceof ResumeRejectedError) return { code: error.rejection.code, message: `Retomada recusada: ${error.rejection.message}` };
    if (error instanceof OpenRefusedError) return { code: error.code, message: `Abertura recusada antes do clique (${error.code}). A pasta exibida não mudou.${verbose}` };
    if (error instanceof FolderIdentityError) return { code: error.code, message: `Identidade da pasta não confirmada (${error.code}). Verifique no Chrome qual pasta está exibida.${verbose}` };
    if (error instanceof ListingNotFoundError) return { code: 'listing-not-found', message: `Nenhuma listagem do AIR reconhecida nesta aba. Faça login e abra uma pasta.${verbose}` };
    if (error instanceof SafetyViolation) return { code: 'safety', message: `Bloqueado pela verificação de segurança; detalhes omitidos por poderem conter nomes, caminhos ou URLs.${verbose}` };
    if (error instanceof Error && /has been closed|Target closed|Browser closed/i.test(error.message)) return { code: 'chrome-closed', message: 'O Chrome dedicado foi fechado durante a operação. O checkpoint gravado foi preservado.' };
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException)?.code) return { code: 'local-failure', message: `Falha local: ${describeLocalFailure(error)}${verbose}` };
    return { code: 'unexpected', message: `A operação falhou; detalhes omitidos por poderem conter nomes, caminhos ou URLs. Verifique a pasta exibida no Chrome dedicado.${verbose}` };
  }
}
