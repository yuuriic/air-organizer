import { OpenRefusedError } from '../safety/scope-validator.js';
import { normalizeName } from './duplicates.js';
import type { AirItem, FolderNode, FolderStatus, PendingReason, ScanResult, TreeEvent, TreeLimits, TreeResult } from '../types/inventory.js';

/**
 * Leitura recursiva controlada (POC-01D), em PROFUNDIDADE (DFS).
 *
 * Por que DFS: sem montar URLs, cada deslocamento é um clique verificado (abrir subpasta /
 * voltar ao pai). Na DFS o caminho de navegação é sempre a pilha atual: cada pasta é aberta
 * uma vez e cada volta é para o pai imediato, o que também mantém o histórico do navegador
 * coerente com a pilha (a volta a partir do 3º nível usa o "voltar" do AIR). Uma BFS exigiria
 * atravessar várias pastas entre nós da mesma camada, sem atalho seguro.
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

/** Subpasta a abrir: posição verificada na listagem já lida do pai. */
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
  /** Volta ao pai e confirma que é ele. Qualquer erro = estado incerto. */
  back(child: FolderView, parent: FolderView): Promise<void>;
}

export type TreeScanOptions = {
  onEvent?: (event: TreeEvent) => void;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const LIMIT_REASONS = new Set<PendingReason>(['max-depth', 'max-folders', 'max-items', 'max-pages']);

export async function scanTree(nav: TreeNavigator, limits: TreeLimits, options: TreeScanOptions = {}): Promise<TreeResult> {
  for (const [k, v] of Object.entries(limits)) {
    if (!Number.isInteger(v) || v < (k === 'maxDepth' ? 0 : 1)) throw new Error(`Limite inválido: ${k}=${v}`);
  }
  const emit = options.onEvent ?? (() => {});
  const folders: FolderNode[] = [];
  const visited = new Set<string>();
  const limitsReached = new Set<TreeResult['limitsReached'][number]>();
  let foldersRead = 0;
  let itemsRead = 0;
  let abort: TreeResult['abort'];

  const node = (name: string, depth: number, parentRef?: string): FolderNode => {
    const n: FolderNode = {
      ref: `F${folders.length + 1}`,
      ...(parentRef ? { parentRef } : {}),
      depth,
      status: 'skipped',
      subtreeStatus: 'skipped',
      reasons: [],
      counts: { items: 0, folders: 0, files: 0, unknown: 0, locationMismatch: 0, pagesRead: 0, unreadPages: [] },
      issueKinds: [],
      name,
      items: [],
      diagnostics: [],
    };
    folders.push(n);
    return n;
  };

  const pending = (n: FolderNode, status: FolderStatus, reason: PendingReason, diagnostic?: string) => {
    n.status = status;
    n.subtreeStatus = status;
    n.reasons.push(reason);
    if (diagnostic) n.diagnostics.push(diagnostic);
    if (LIMIT_REASONS.has(reason)) {
      const limit = reason as TreeResult['limitsReached'][number];
      if (!limitsReached.has(limit)) emit({ type: 'limit-reached', ref: n.ref, depth: n.depth, reasons: [reason] });
      limitsReached.add(limit);
    }
    emit({ type: 'folder-pending', ref: n.ref, depth: n.depth, status, reasons: [reason] });
  };

  async function visit(n: FolderNode, view: FolderView, ancestors: readonly string[]): Promise<void> {
    visited.add(view.key);
    foldersRead++;
    n.path = view.path;
    n.pageUrl = view.key;

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
    emit({ type: 'folder-read', ref: n.ref, depth: n.depth, status: n.status, reasons: n.reasons, items: n.counts.items, pages: c.pagesRead });

    // Homônimos: qualquer outro item da pasta com o mesmo nome normalizado impede identificar a linha.
    const nameCount = new Map<string, number>();
    for (const item of scan.items) nameCount.set(normalizeName(item.name), (nameCount.get(normalizeName(item.name)) ?? 0) + 1);
    const children: Array<[AirItem, FolderNode]> = scan.items.filter((i) => i.kind === 'folder').map((i) => [i, node(i.name, n.depth + 1, n.ref)]);

    for (const [item, child] of children) {
      if (abort) {
        pending(child, 'skipped', 'run-aborted');
        continue;
      }
      if ((nameCount.get(normalizeName(item.name)) ?? 0) > 1) {
        pending(child, 'skipped', 'homonym');
        continue;
      }
      if (view.path !== undefined && item.path !== view.path) {
        pending(child, 'skipped', 'location-mismatch');
        continue;
      }
      if (child.depth > limits.maxDepth) {
        pending(child, 'skipped', 'max-depth');
        continue;
      }
      if (foldersRead >= limits.maxFolders) {
        pending(child, 'skipped', 'max-folders');
        continue;
      }
      if (itemsRead >= limits.maxItems) {
        pending(child, 'skipped', 'max-items');
        continue;
      }

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
          pending(child, 'failed', 'open-refused', error.message);
          continue;
        }
        abort = { reason: 'navigation-lost', atRef: child.ref, message: message(error) };
        pending(child, 'failed', 'navigation-lost', message(error));
        emit({ type: 'aborted', ref: child.ref, depth: child.depth, reasons: ['navigation-lost'] });
        continue;
      }

      if (ancestors.includes(childView.key) || childView.key === view.key) {
        pending(child, 'failed', 'cycle');
      } else if (visited.has(childView.key)) {
        pending(child, 'skipped', 'repeated-visit');
      } else {
        await visit(child, childView, [...ancestors, view.key]);
      }
      if (abort) continue; // nenhum clique após perda de navegação, nem para voltar

      try {
        await nav.back(childView, view);
      } catch (error) {
        abort = { reason: 'return-failed', atRef: child.ref, message: message(error) };
        n.reasons.push('return-failed');
        n.diagnostics.push(message(error));
        emit({ type: 'aborted', ref: child.ref, depth: child.depth, reasons: ['return-failed'] });
      }
    }

    // Subárvore: completa só se a pasta e todos os descendentes estiverem completos, sem pendências.
    const childrenComplete = children.every(([, ch]) => ch.subtreeStatus === 'complete');
    const clean = n.counts.unknown === 0 && n.counts.locationMismatch === 0 && !n.reasons.includes('return-failed');
    n.subtreeStatus = n.status === 'complete' && clean && childrenComplete ? 'complete' : 'partial';
  }

  const startView = await nav.current();
  const root = node(startView.title, 0);
  await visit(root, startView, []);

  const status: TreeResult['status'] = abort || root.status === 'failed' ? 'failed' : root.subtreeStatus === 'complete' ? 'complete' : 'partial';
  const read = folders.filter((f) => f.status === 'complete' || f.status === 'partial');
  return {
    status,
    limits,
    ...(abort ? { abort } : {}),
    limitsReached: [...limitsReached],
    folders,
    totals: {
      foldersRead: read.length,
      foldersPending: folders.filter((f) => f.subtreeStatus !== 'complete').length,
      items: read.reduce((s, f) => s + f.counts.items, 0),
      folders: read.reduce((s, f) => s + f.counts.folders, 0),
      files: read.reduce((s, f) => s + f.counts.files, 0),
      unknown: read.reduce((s, f) => s + f.counts.unknown, 0),
    },
  };
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
    ...(result.abort ? { abort: { reason: result.abort.reason, atRef: result.abort.atRef } } : {}),
    totals: result.totals,
    folders: result.folders.map(({ ref, parentRef, depth, status, subtreeStatus, reasons, refusal, counts, issueKinds }) => ({
      ref,
      ...(parentRef ? { parentRef } : {}),
      depth,
      status,
      subtreeStatus,
      reasons,
      ...(refusal ? { refusal } : {}),
      counts,
      issueKinds,
    })),
  };
}

/** Linha de log padrão de um evento (sem dados identificáveis). */
export function formatTreeEvent(e: TreeEvent): string {
  const indent = '  '.repeat(e.depth);
  const reasons = e.reasons?.length ? ` [${e.reasons.join(', ')}]` : '';
  if (e.type === 'folder-read') return `${indent}${e.ref} lida: ${e.items} itens, ${e.pages} pág. → ${e.status}${reasons}`;
  if (e.type === 'folder-pending') return `${indent}${e.ref} ${e.status}${reasons}`;
  if (e.type === 'limit-reached') return `${indent}! limite atingido em ${e.ref}${reasons}`;
  return `${indent}!! execução interrompida em ${e.ref}${reasons}`;
}
