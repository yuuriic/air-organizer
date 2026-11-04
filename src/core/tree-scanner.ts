import { OpenRefusedError } from '../safety/scope-validator.js';
import { ResumeRejectedError, idsFor, isSettledSubtree, subtreeOf, type CheckpointFolder, type Pseudonymize } from './checkpoint.js';
import type {
  AirItem,
  FolderNode,
  FolderStatus,
  NavigationDiagnostic,
  PageReadResult,
  PendingReason,
  ScanResult,
  TreeEvent,
  TreeLimits,
  TreeProgress,
  TreeResult,
  TreeTotals,
  ResumeMode,
} from '../types/inventory.js';

/**
 * Leitura recursiva controlada (POC-01D), em PROFUNDIDADE (DFS).
 *
 * Por que DFS: sem montar URLs, cada deslocamento é um clique verificado (abrir subpasta /
 * voltar ao pai). Na DFS o caminho de navegação é sempre a pilha atual: cada pasta é aberta
 * uma vez e cada volta é para o pai imediato, o que também mantém o histórico do navegador
 * coerente com a pilha (a volta a partir do 3º nível usa o "voltar" do AIR). Uma BFS exigiria
 * atravessar várias pastas entre nós da mesma camada, sem atalho seguro.
 *
 * Retomada (POC-01E): a mesma DFS, a partir da mesma pasta inicial. Uma subpasta cuja subárvore
 * está assentada no checkpoint e cuja linha no pai é idêntica à registrada não é reaberta;
 * todas as demais são lidas de novo. Ver ARCHITECTURE.md §7.7.
 *
 * Sem Playwright: a navegação real fica atrás de TreeNavigator (adaptador em src/air).
 */

/** Pasta exibida, com identidade verificada pelo adaptador. */
export type FolderView = {
  /** Chave da pasta NESTA execução (URL sem query). Não é tratada como ID global estável. */
  key: string;
  title: string;
  total: number;
  path?: string;
};

/**
 * Subpasta a abrir. `sourcePage`/`rowIndex` são só localizadores temporários na listagem já lida
 * do pai (revalidados antes do clique); a identidade persistente da pasta é a URL (`FolderView.key`).
 */
export type ChildRef = { name: string; sourcePage: number; rowIndex: number; expectedPath?: string };

export interface TreeNavigator {
  /** Pasta exibida agora. */
  current(): Promise<FolderView>;
  /** Lê as páginas da pasta exibida, a partir da 1ª. */
  scan(limits: { maxPages: number; maxItems: number }): Promise<ScanResult>;
  /**
   * Abre a subpasta e confirma a identidade. Deve lançar OpenRefusedError quando recusar
   * ANTES de clicar (a pasta exibida continua sendo `parent`); qualquer outro erro significa
   * que a navegação está em estado incerto.
   */
  open(parent: FolderView, parentScan: ScanResult, child: ChildRef): Promise<FolderView>;
  /**
   * Volta ao pai e confirma a IDENTIDADE dele. Qualquer erro = estado incerto. Identidade
   * confirmada com total ou listagem divergentes do lido antes = `contentChanged` (ADR-013).
   */
  back(child: FolderView, parent: FolderView): Promise<BackOutcome | void>;
}

/** Resultado de uma volta confirmada. */
export type BackOutcome = { contentChanged?: { total: boolean; listing: boolean } };

/** Estado gravável a cada passo. `final` só na última gravação da sessão. */
export type TreeCheckpointSnapshot = {
  folders: CheckpointFolder[];
  totals: TreeTotals;
  limitsReached: TreeResult['limitsReached'];
  final?: TreeResult;
};

export type TreeScanOptions = {
  onEvent?: (event: TreeEvent) => void;
  checkpoint?: {
    pseudonymize: Pseudonymize;
    /** Chamado depois de cada pasta lida, de cada filho decidido e no fim. */
    save: (snapshot: TreeCheckpointSnapshot) => Promise<void>;
    /**
     * Retomada de uma execução anterior. Os dois modos usam esta mesma DFS; a diferença é só
     * se subárvores assentadas podem ser reaproveitadas sem reabrir ('fast') ou não ('verified').
     */
    resume?: { from: readonly CheckpointFolder[]; mode: ResumeMode };
  };
  now?: () => string;
  /**
   * Subpastas irmãs com o MESMO nome lido (nada na linha as distingue antes do clique):
   * - 'refuse' (padrão): não são abertas (pendência 'homonym'); o inventário fica parcial.
   * - 'identify-by-url': cada uma é aberta pela sua linha e identificada depois pela URL própria.
   *   Depende de a URL identificar a pasta de forma estável durante a execução, o que ainda NÃO foi
   *   validado no AIR real (README, "Limitações conhecidas"); a CLI não habilita este modo.
   * Nomes que diferem por caixa, acento ou pontuação nunca são ambíguos (título e caminho são
   * comparados exatamente) e são abertos nos dois modos.
   */
  homonyms?: 'refuse' | 'identify-by-url';
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Código e verificações seguras que o adaptador anexa ao erro de navegação (duck typing: core não depende de air). */
function diagnosticOf(error: unknown): { diagnostic?: NavigationDiagnostic } {
  const e = error as { code?: unknown; category?: unknown; checks?: NavigationDiagnostic['checks'] } | null;
  if (!e || typeof e.code !== 'string') return {};
  const category = e.category === 'identity-mismatch' || e.category === 'navigation-failed' ? e.category : undefined;
  return { diagnostic: { ...(category ? { category } : {}), code: e.code, ...(e.checks ? { checks: e.checks } : {}) } };
}

const LIMIT_REASONS = new Set<PendingReason>(['max-depth', 'max-folders', 'max-items', 'max-pages']);

/** Dados da pasta usados só pelo checkpoint (pseudonimizados na gravação). */
type Meta = {
  rowKey?: string;
  key?: string;
  total?: number;
  pages: PageReadResult[];
  settled: boolean;
  observedAt: string;
  reused?: CheckpointFolder;
};

export async function scanTree(nav: TreeNavigator, limits: TreeLimits, options: TreeScanOptions = {}): Promise<TreeResult> {
  for (const [k, v] of Object.entries(limits)) {
    if (!Number.isInteger(v) || v < (k === 'maxDepth' ? 0 : 1)) throw new Error(`Limite inválido: ${k}=${v}`);
  }
  const emit = options.onEvent ?? (() => {});
  const now = options.now ?? (() => new Date().toISOString());
  const checkpoint = options.checkpoint;
  const homonymPolicy = options.homonyms ?? 'refuse';
  const ids = checkpoint ? idsFor(checkpoint.pseudonymize) : undefined;
  const previous = checkpoint?.resume?.from;
  const mode = checkpoint?.resume?.mode;
  const compared = { unchanged: 0, changed: 0, new: 0, removed: 0 };

  const folders: FolderNode[] = [];
  const meta = new Map<FolderNode, Meta>();
  const visited = new Set<string>();
  /** Pastas reaproveitadas do checkpoint (pseudônimo da URL): abri-las de novo seria visita repetida. */
  const reusedKeyIds = new Set<string>();
  const limitsReached = new Set<TreeResult['limitsReached'][number]>();
  let foldersRead = 0;
  let itemsRead = 0;
  let reusedFolders = 0;
  let contentChanged = 0;
  let oldestReused: string | undefined;
  let abort: TreeResult['abort'];

  const node = (name: string | undefined, depth: number, parentRef?: string, rowKey?: string): FolderNode => {
    const n: FolderNode = {
      ref: `F${folders.length + 1}`,
      ...(parentRef ? { parentRef } : {}),
      depth,
      status: 'skipped',
      subtreeStatus: 'skipped',
      reasons: [],
      counts: { items: 0, folders: 0, files: 0, unknown: 0, locationMismatch: 0, pagesRead: 0, unreadPages: [] },
      issueKinds: [],
      ...(name !== undefined ? { name } : {}),
      items: [],
      diagnostics: [],
    };
    folders.push(n);
    meta.set(n, { ...(rowKey ? { rowKey } : {}), pages: [], settled: false, observedAt: now() });
    return n;
  };

  const pending = (n: FolderNode, status: FolderStatus, reason: PendingReason, diagnostic?: string) => {
    n.status = status;
    n.subtreeStatus = status;
    n.reasons.push(reason);
    meta.get(n)!.settled = true;
    if (diagnostic) n.diagnostics.push(diagnostic);
    if (LIMIT_REASONS.has(reason)) {
      const limit = reason as TreeResult['limitsReached'][number];
      if (!limitsReached.has(limit)) emit({ type: 'limit-reached', ref: n.ref, depth: n.depth, reasons: [reason] });
      limitsReached.add(limit);
    }
    emit({ type: 'folder-pending', ref: n.ref, depth: n.depth, status, reasons: [reason] });
  };

  const totals = (): TreeTotals => {
    const read = folders.filter((f) => f.status === 'complete' || f.status === 'partial');
    return {
      foldersRead: read.length,
      foldersPending: folders.filter((f) => f.subtreeStatus !== 'complete').length,
      items: read.reduce((s, f) => s + f.counts.items, 0),
      folders: read.reduce((s, f) => s + f.counts.folders, 0),
      files: read.reduce((s, f) => s + f.counts.files, 0),
      unknown: read.reduce((s, f) => s + f.counts.unknown, 0),
      pagesRead: read.reduce((s, f) => s + f.counts.pagesRead, 0),
    };
  };

  const progress = () => {
    const t = totals();
    const p: TreeProgress = { foldersRead: t.foldersRead, items: t.items, pages: t.pagesRead, pending: folders.filter((f) => f.reasons.length > 0).length };
    emit({ type: 'progress', ref: '', depth: 0, progress: p });
  };

  const snapshotFolders = (): CheckpointFolder[] =>
    folders.map((f) => {
      const m = meta.get(f)!;
      const rowId = m.rowKey ? ids!.row(m.rowKey) : undefined;
      if (m.reused) {
        return { ...m.reused, ref: f.ref, parentRef: f.parentRef, depth: f.depth, ...(rowId ? { rowId } : {}), settled: true };
      }
      return {
        ref: f.ref,
        ...(f.parentRef ? { parentRef: f.parentRef } : {}),
        depth: f.depth,
        nameId: ids!.name(f.name ?? ''),
        ...(rowId ? { rowId } : {}),
        ...(m.key ? { keyId: ids!.key(m.key) } : {}),
        ...(f.path ? { pathId: ids!.path(f.path) } : {}),
        ...(m.total !== undefined ? { total: m.total } : {}),
        pages: m.pages.map((p) => ({ n: p.pageNumber, signatureId: ids!.page(p.signature), rows: p.rowCount })),
        status: f.status,
        subtreeStatus: f.subtreeStatus,
        reasons: [...f.reasons],
        ...(f.refusal ? { refusal: f.refusal } : {}),
        counts: { ...f.counts, unreadPages: [...f.counts.unreadPages] },
        issueKinds: [...f.issueKinds],
        settled: m.settled,
        observedAt: m.observedAt,
      };
    });

  const save = async (final?: TreeResult) => {
    if (!checkpoint) return;
    await checkpoint.save({ folders: snapshotFolders(), totals: totals(), limitsReached: [...limitsReached], ...(final ? { final } : {}) });
  };

  /** Registro do checkpoint para a subpasta `name` de `parent`: só se o nome for único (homônimos são associados depois do clique, pela URL). */
  const childRecord = (parent: CheckpointFolder | undefined, name: string): CheckpointFolder | undefined => {
    if (!parent || !previous || !ids) return undefined;
    const matches = previous.filter((f) => f.parentRef === parent.ref && f.nameId === ids.name(name));
    return matches.length === 1 ? matches[0] : undefined;
  };

  /**
   * Reaproveita a subárvore assentada `record` no nó `child`, sem clique. A linha da pasta na
   * listagem do pai, relida agora, já foi comparada com a registrada.
   */
  const reuse = (child: FolderNode, record: CheckpointFolder) => {
    const tree = subtreeOf(previous!, record.ref);
    const nodeOf = new Map<string, FolderNode>([[record.ref, child]]);
    for (const r of tree) {
      const n = r === record ? child : node(undefined, r.depth, nodeOf.get(r.parentRef!)!.ref, undefined);
      nodeOf.set(r.ref, n);
      n.status = r.status;
      n.subtreeStatus = r.subtreeStatus;
      n.reasons = [...r.reasons];
      if (r.refusal) n.refusal = r.refusal;
      n.counts = { ...r.counts, unreadPages: [...r.counts.unreadPages] };
      n.issueKinds = [...r.issueKinds];
      n.reusedFrom = r.observedAt;
      const m = meta.get(n)!;
      n.verification = 'reused';
      m.reused = r;
      m.settled = true;
      if (r.keyId) reusedKeyIds.add(r.keyId);
      if (r.status === 'complete' || r.status === 'partial') {
        foldersRead++;
        itemsRead += r.counts.items;
      }
      if (!oldestReused || r.observedAt < oldestReused) oldestReused = r.observedAt;
    }
    reusedFolders += tree.length;
    emit({ type: 'folder-reused', ref: child.ref, depth: child.depth, status: child.subtreeStatus, folders: tree.length });
  };

  async function visit(n: FolderNode, view: FolderView, ancestors: readonly string[], record: CheckpointFolder | undefined): Promise<void> {
    visited.add(view.key);
    foldersRead++;
    n.path = view.path;
    n.pageUrl = view.key;
    const m = meta.get(n)!;
    m.key = view.key;
    m.total = view.total;
    m.observedAt = now();

    let scan: ScanResult;
    try {
      scan = await nav.scan({ maxPages: limits.maxPagesPerFolder, maxItems: Math.max(1, limits.maxItems - itemsRead) });
    } catch (error) {
      pending(n, 'failed', 'read-error', message(error));
      return;
    }
    const c = scan.coverage;
    itemsRead += scan.items.length;
    n.items = scan.items;
    m.pages = scan.pages;
    n.issueKinds = [...new Set(c.issues.map((i) => i.kind))];
    n.diagnostics.push(...c.issues.map((i) => i.message));
    n.counts = {
      items: scan.items.length,
      folders: scan.items.filter((i) => i.kind === 'folder').length,
      files: scan.items.filter((i) => i.kind === 'file').length,
      unknown: scan.items.filter((i) => i.kind === 'unknown').length,
      locationMismatch: scan.items.filter((i) => view.path !== undefined && i.path !== view.path).length,
      pagesRead: c.pagesRead,
      unreadPages: c.unreadPages,
    };
    n.status = c.complete ? 'complete' : 'partial';
    if (!c.complete) {
      const reason: PendingReason = c.stopReason === 'max-pages' ? 'max-pages' : c.stopReason === 'max-items' ? 'max-items' : 'read-incomplete';
      n.reasons.push(reason);
      if (reason === 'max-pages' || reason === 'max-items') {
        if (!limitsReached.has(reason)) emit({ type: 'limit-reached', ref: n.ref, depth: n.depth, reasons: [reason] });
        limitsReached.add(reason);
      }
    }
    // Item de tipo desconhecido pode ser uma pasta com descendentes: a subárvore não é completa.
    if (n.counts.unknown > 0) n.reasons.push('unknown-items');
    // Item cujo "Caminho" aponta para outro ramo: pertencimento incerto, nunca aberto.
    if (n.counts.locationMismatch > 0) n.reasons.push('location-mismatch');

    // Retomada (qualquer modo): pasta relida agora comparada com o registro. Só as páginas lidas
    // nas duas sessões entram na comparação (os limites podem ter mudado entre elas).
    if (previous && ids) {
      // Registro sem URL = pasta nunca aberta antes (só pendência): não há o que comparar.
      if (!record || record.keyId === undefined) {
        n.verification = 'new';
        compared.new++;
      } else {
        const current = scan.pages.map((p) => ids.page(p.signature));
        const common = Math.min(current.length, record.pages.length);
        const same = record.total === view.total && record.pages.slice(0, common).every((p, i) => p.signatureId === current[i]);
        n.verification = same ? 'unchanged' : 'changed';
        compared[n.verification]++;
      }
    }
    emit({ type: 'folder-read', ref: n.ref, depth: n.depth, status: n.status, reasons: n.reasons, items: n.counts.items, pages: c.pagesRead });
    progress();
    await save();

    // Homônimos (subpastas com o MESMO nome lido): nenhuma informação da linha as distingue antes
    // do clique. Com 'identify-by-url', cada uma é aberta pela sua linha (localizador temporário,
    // revalidado antes do clique) e identificada DEPOIS pela URL própria da pasta, conferida com
    // título, breadcrumb e "Caminho". Duas aberturas na mesma URL = identidade ambígua (pendência
    // 'homonym'): o grupo só é completo se cada linha levar a uma pasta diferente. Nomes que
    // diferem só por caixa, acento ou pontuação não são ambíguos: título e caminho são exatos.
    const sameName = new Map<string, number>();
    for (const item of scan.items) if (item.kind === 'folder') sameName.set(item.name, (sameName.get(item.name) ?? 0) + 1);
    const children: Array<[AirItem, FolderNode]> = scan.items
      .filter((i) => i.kind === 'folder')
      .map((i) => [i, node(i.name, n.depth + 1, n.ref, i.observationKey)]);
    // Subpastas registradas que sumiram da listagem — só afirmável com a listagem inteira relida.
    if (record && previous && ids && n.status === 'complete') {
      // Por multiplicidade: um de dois homônimos removido também conta.
      const present = new Map<string, number>();
      for (const [i] of children) present.set(ids.name(i.name), (present.get(ids.name(i.name)) ?? 0) + 1);
      const recorded = new Map<string, number>();
      for (const f of previous) if (f.parentRef === record.ref) recorded.set(f.nameId, (recorded.get(f.nameId) ?? 0) + 1);
      for (const [nameId, count] of recorded) compared.removed += Math.max(0, count - (present.get(nameId) ?? 0));
    }

    let stale = false;
    for (const [item, child] of children) {
      await decide(item, child);
      await save();
    }

    async function decide(item: AirItem, child: FolderNode): Promise<void> {
      if (abort) return pending(child, 'skipped', 'run-aborted');
      // ADR-013: depois de conteúdo divergente, a listagem lida não sustenta novos cliques.
      if (stale) return pending(child, 'skipped', 'content-changed');
      const homonyms = (sameName.get(item.name) ?? 0) > 1;
      if (homonyms && homonymPolicy !== 'identify-by-url') return pending(child, 'skipped', 'homonym');
      if (view.path !== undefined && item.path !== view.path) return pending(child, 'skipped', 'location-mismatch');

      // Retomada RÁPIDA: a linha relida agora precisa ser idêntica à registrada (todos os metadados).
      // Na VERIFICADA nada é reaproveitado: a linha do pai não reflete mudanças internas.
      let childRec = childRecord(record, item.name);
      // ADR-013: filhos de pasta com conteúdo divergente no checkpoint nunca são reaproveitados.
      const parentChanged = record?.reasons.includes('content-changed') ?? false;
      if (mode === 'fast' && !parentChanged && childRec && ids && previous && childRec.rowId === ids.row(item.observationKey) && isSettledSubtree(previous, childRec.ref)) {
        const deepest = Math.max(...subtreeOf(previous, childRec.ref).map((f) => f.depth));
        if (deepest <= limits.maxDepth) {
          reuse(child, childRec);
          progress();
          return;
        }
      }

      if (child.depth > limits.maxDepth) return pending(child, 'skipped', 'max-depth');
      if (foldersRead >= limits.maxFolders) return pending(child, 'skipped', 'max-folders');
      if (itemsRead >= limits.maxItems) return pending(child, 'skipped', 'max-items');

      const ref: ChildRef = {
        name: item.name,
        sourcePage: item.sourcePage,
        rowIndex: item.rowIndex,
        ...(item.path ? { expectedPath: `${item.path}/${item.name}` } : {}),
      };
      let childView: FolderView;
      try {
        childView = await nav.open(view, scan, ref);
      } catch (error) {
        if (error instanceof OpenRefusedError) {
          child.refusal = error.code;
          return pending(child, 'failed', 'open-refused', error.message);
        }
        abort = { reason: 'navigation-lost', atRef: child.ref, message: message(error), ...diagnosticOf(error) };
        pending(child, 'failed', 'navigation-lost', message(error));
        emit({ type: 'aborted', ref: child.ref, depth: child.depth, reasons: ['navigation-lost'] });
        return;
      }

      // Homônimo: o registro do checkpoint só é associado depois do clique, pela URL.
      if (!childRec && homonyms && record && previous && ids) {
        const byKey = previous.filter((f) => f.parentRef === record.ref && f.nameId === ids.name(item.name) && f.keyId === ids.key(childView.key));
        if (byKey.length === 1) childRec = byKey[0];
      }
      // Outra URL que a registrada para este nome: o registro antigo não descreve esta pasta.
      if (childRec?.keyId && ids && childRec.keyId !== ids.key(childView.key)) childRec = undefined;

      if (ancestors.includes(childView.key) || childView.key === view.key) {
        pending(child, 'failed', 'cycle');
      } else if (visited.has(childView.key) || (ids && reusedKeyIds.has(ids.key(childView.key)))) {
        // Entre homônimos, outra linha que leva à mesma pasta: não dá para afirmar que todas foram lidas.
        pending(child, 'skipped', homonyms ? 'homonym' : 'repeated-visit');
      } else {
        await visit(child, childView, [...ancestors, view.key], childRec);
      }
      if (abort) return; // nenhum clique após perda de navegação, nem para voltar

      try {
        const outcome = await nav.back(childView, view);
        if (outcome?.contentChanged) {
          // Identidade confirmada, conteúdo divergente: aceita a volta e invalida a pasta (e, pela
          // subárvore, os ancestrais). Sem releitura automática nesta sessão: nada de loop.
          stale = true;
          n.status = 'partial';
          n.reasons.push('content-changed');
          contentChanged++;
          emit({ type: 'folder-pending', ref: n.ref, depth: n.depth, status: 'partial', reasons: ['content-changed'] });
        }
      } catch (error) {
        abort = { reason: 'return-failed', atRef: child.ref, message: message(error), ...diagnosticOf(error) };
        n.reasons.push('return-failed');
        n.diagnostics.push(message(error));
        emit({ type: 'aborted', ref: child.ref, depth: child.depth, reasons: ['return-failed'] });
      }
    }

    // Subárvore: completa só se a pasta e todos os descendentes estiverem completos, sem pendências.
    const childrenComplete = children.every(([, ch]) => ch.subtreeStatus === 'complete');
    const clean = n.counts.unknown === 0 && n.counts.locationMismatch === 0 && !n.reasons.includes('return-failed');
    n.subtreeStatus = n.status === 'complete' && clean && childrenComplete ? 'complete' : 'partial';
    m.settled = true;
  }

  const startView = await nav.current();
  let rootRecord: CheckpointFolder | undefined;
  if (previous && ids) {
    // Antes de qualquer clique: a pasta exibida precisa ser a pasta inicial gravada.
    rootRecord = previous.find((f) => !f.parentRef);
    const samePath = (rootRecord?.pathId ?? '') === (startView.path !== undefined ? ids.path(startView.path) : '');
    if (!rootRecord || rootRecord.keyId !== ids.key(startView.key) || rootRecord.nameId !== ids.name(startView.title) || !samePath) {
      throw new ResumeRejectedError({ code: 'start-folder-mismatch', message: 'A pasta exibida não é a pasta inicial da execução gravada (URL, título ou caminho). Navegue manualmente até ela.' });
    }
  }
  const root = node(startView.title, 0);
  await visit(root, startView, [], rootRecord);

  // Completa só com a subárvore inteira completa e nenhum limite atingido nesta sessão.
  const status: TreeResult['status'] =
    abort || root.status === 'failed' ? 'failed' : root.subtreeStatus === 'complete' && limitsReached.size === 0 ? 'complete' : 'partial';
  // Conteúdo revalidado = toda pasta contada foi lida nesta sessão (nenhuma reaproveitada).
  const contentRevalidated = reusedFolders === 0;
  const abortCategory = abort?.diagnostic?.category ?? (abort ? 'navigation-failed' : undefined);
  const result: TreeResult = {
    status,
    limits,
    ...(abort ? { abort } : {}),
    limitsReached: [...limitsReached],
    folders,
    totals: totals(),
    ...(previous && mode
      ? { resume: { mode, reusedFolders, ...(oldestReused ? { oldestReusedObservation: oldestReused } : {}), ...compared } }
      : {}),
    verification: { contentRevalidated, eligibleForPlanning: status === 'complete' && contentRevalidated && contentChanged === 0 },
    navigation: { contentChanged, identityMismatch: abortCategory === 'identity-mismatch' ? 1 : 0, navigationFailed: abortCategory === 'navigation-failed' ? 1 : 0 },
  };
  await save(result);
  return result;
}

/**
 * Relatório diagnóstico SEM dados identificáveis (padrão): referências sequenciais,
 * profundidade, status, motivos, contagens e tipos de problema. Sem nomes, caminhos,
 * URLs nem mensagens.
 */
export function diagnosticReport(result: TreeResult) {
  return {
    status: result.status,
    limits: result.limits,
    limitsReached: result.limitsReached,
    ...(result.abort
      ? { abort: { reason: result.abort.reason, atRef: result.abort.atRef, ...(result.abort.diagnostic ? { diagnostic: result.abort.diagnostic } : {}) } }
      : {}),
    ...(result.resume ? { resume: result.resume } : {}),
    verification: result.verification,
    navigation: result.navigation,
    totals: result.totals,
    folders: result.folders.map(({ ref, parentRef, depth, status, subtreeStatus, reasons, refusal, counts, issueKinds, reusedFrom, verification }) => ({
      ref,
      ...(parentRef ? { parentRef } : {}),
      depth,
      status,
      subtreeStatus,
      reasons,
      ...(refusal ? { refusal } : {}),
      ...(reusedFrom ? { reusedFrom } : {}),
      ...(verification ? { verification } : {}),
      counts,
      issueKinds,
    })),
  };
}

/** Linha de log padrão de um evento (sem dados identificáveis). */
export function formatTreeEvent(e: TreeEvent): string {
  const indent = '  '.repeat(e.depth);
  const reasons = e.reasons?.length ? ` [${e.reasons.join(', ')}]` : '';
  if (e.type === 'progress' && e.progress) {
    const p = e.progress;
    return `  [executando] pastas ${p.foldersRead} · itens ${p.items} · páginas ${p.pages} · pendências ${p.pending}`;
  }
  if (e.type === 'folder-read') return `${indent}${e.ref} lida: ${e.items} itens, ${e.pages} pág. → ${e.status}${reasons}`;
  if (e.type === 'folder-reused') return `${indent}${e.ref} reaproveitada do checkpoint SEM revalidar o conteúdo (${e.folders} pasta(s), só a linha no pai conferida) → ${e.status}`;
  if (e.type === 'folder-pending') return `${indent}${e.ref} ${e.status}${reasons}`;
  if (e.type === 'limit-reached') return `${indent}! limite atingido em ${e.ref}${reasons}`;
  return `${indent}!! execução interrompida em ${e.ref}${reasons}`;
}
