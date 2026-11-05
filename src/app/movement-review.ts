import { MAX_JUSTIFICATION_LENGTH, isProposalId, isValidJustification, type HumanDecision, type ProposalDecisionState } from '../core/movement-decisions.js';
import { deriveEmptyFolderPaths, type BlockerCode, type ConflictCode, type ConsolidationGroup, type MovementKind, type MovementPlan, type MovementSelection, type MovementState } from '../core/movement-planner.js';
import { byRef } from '../core/structural-diagnostics.js';
import type { AirItem, FolderNode, TreeInventoryExport } from '../types/inventory.js';
import { InvalidInput } from './validation.js';

/**
 * Seleção de origem e destino para a prévia de movimentações. A janela só conhece identificadores
 * opacos (F<n> para pastas, A<n> para arquivos) e rótulos neutros; nomes e caminhos ficam aqui, no
 * processo principal, e só saem por `revealSelectionNames`, depois de ação explícita do operador.
 *
 * Os bloqueios daqui só antecipam erros evidentes: a avaliação final é sempre do motor (§9.3).
 */

/** 'unavailable': sem caminho comprovável. 'ambiguous': homônimos no caminho ou nome repetido na pasta. */
export type NodeIdentity = 'observed' | 'derived' | 'unavailable' | 'ambiguous';

/** Sem nomes, caminhos nem URLs: pode ir à janela. */
export type SelectionNode = {
  id: string;
  kind: 'folder' | 'file' | 'unknown';
  parent?: string;
  depth: number;
  identity: NodeIdentity;
  canBeSource: boolean;
  canBeDestination: boolean;
  /** Só em pastas: conteúdo direto, conforme a listagem. */
  folders?: number;
  files?: number;
};

export type SelectionTree = {
  nodes: SelectionNode[];
  /** Só no processo principal. */
  names: Record<string, string>;
  selectors: Map<string, { path: string; ref: string } | { parent: { path: string; ref: string }; name: string }>;
  /** Arquivo do plano → identificador opaco. */
  fileIds: Map<string, string>;
};

const fileKey = (parentRef: string, observationKey: string | undefined) => `${parentRef}\u0000${observationKey}`;

/** Constrói a árvore de um inventário JÁ aceito pelo motor. */
export function buildSelectionTree(inv: TreeInventoryExport): SelectionTree {
  const { derived } = deriveEmptyFolderPaths(inv);
  const sorted = [...inv.folders].sort(byRef);
  const folders = new Map(sorted.map((f) => [f.ref, f]));
  const kids = new Map<string, FolderNode[]>();
  for (const f of sorted) if (f.parentRef) kids.set(f.parentRef, [...(kids.get(f.parentRef) ?? []), f]);
  const pathOf = (f: FolderNode) => f.path ?? derived.get(f.ref);
  const pathCount = new Map<string, number>();
  for (const f of sorted) {
    const p = pathOf(f);
    if (p !== undefined) pathCount.set(p, (pathCount.get(p) ?? 0) + 1);
  }
  const identityOf = (f: FolderNode): NodeIdentity => {
    const p = pathOf(f);
    if (p === undefined) return 'unavailable';
    for (let a: FolderNode | undefined = f; a; a = a.parentRef ? folders.get(a.parentRef) : undefined) {
      const ap = pathOf(a);
      if (ap !== undefined && (pathCount.get(ap) ?? 0) > 1) return 'ambiguous';
    }
    return derived.has(f.ref) ? 'derived' : 'observed';
  };

  const tree: SelectionTree = { nodes: [], names: {}, selectors: new Map(), fileIds: new Map() };
  let files = 0;
  let unknown = 0;
  const visitFile = (parent: FolderNode, item: AirItem, usable: boolean) => {
    const isFile = item.kind === 'file';
    const id = isFile ? `A${++files}` : `I${++unknown}`;
    const repeated = parent.items.filter((i) => i.name === item.name).length > 1;
    const canBeSource = isFile && usable && !repeated;
    tree.nodes.push({ id, kind: isFile ? 'file' : 'unknown', parent: parent.ref, depth: parent.depth + 1, identity: repeated || !usable ? 'ambiguous' : 'observed', canBeSource, canBeDestination: false });
    tree.names[id] = item.name;
    if (isFile) tree.fileIds.set(fileKey(parent.ref, item.observationKey), id);
    if (canBeSource) tree.selectors.set(id, { parent: { path: pathOf(parent)!, ref: parent.ref }, name: item.name });
  };
  const visitFolder = (f: FolderNode) => {
    const identity = identityOf(f);
    const usable = identity === 'observed' || identity === 'derived';
    const p = pathOf(f);
    tree.nodes.push({
      id: f.ref,
      kind: 'folder',
      ...(f.parentRef ? { parent: f.parentRef } : {}),
      depth: f.depth,
      identity,
      canBeSource: usable && f.parentRef !== undefined,
      canBeDestination: usable,
      folders: f.counts.folders,
      files: f.counts.files,
    });
    if (f.name !== undefined) tree.names[f.ref] = f.name;
    if (usable && p !== undefined) tree.selectors.set(f.ref, { path: p, ref: f.ref });
    // Mesma ordem da listagem: subpastas são pareadas às linhas de pasta, como no restante do motor.
    const children = kids.get(f.ref) ?? [];
    let kid = 0;
    for (const item of f.items) {
      if (item.kind === 'folder') {
        const child = children[kid++];
        if (child) visitFolder(child);
      } else visitFile(f, item, usable);
    }
  };
  const root = sorted.find((f) => !f.parentRef);
  if (root) visitFolder(root);
  return tree;
}

const REFUSED_SOURCE = 'Escolha uma origem disponível na lista.';
const REFUSED_DESTINATION = 'Escolha uma pasta de destino disponível na lista.';
const REFUSED_MODE = 'Escolha o que fazer com a pasta de origem: levar a pasta ou consolidar o conteúdo.';

/** Teto do que atravessa o IPC. Acima disso, a seleção não é oferecida. */
export const MAX_SELECTION_NODES = 50_000;

const INVENTORY_ID = /^inv-[0-9a-f]{16}$/;
const NODE_ID = /^[FA][1-9]\d{0,8}$/;
const REQUEST_KEYS = new Set(['inventoryId', 'source', 'destination', 'mode']);

/** Só o formato do identificador opaco: nenhum caminho, e o valor recebido nunca volta numa mensagem. */
export function parseInventoryId(input: unknown): string {
  if (typeof input !== 'string' || !INVENTORY_ID.test(input)) throw new InvalidInput('Inventário inválido. Atualize a lista.');
  return input;
}

export type PreviewRequest = { inventoryId: string; source: string; destination: string; mode?: 'folder' | 'folder-contents' };

/** Validação em tempo de execução do pedido vindo da janela. Campos desconhecidos são recusados. */
export function parsePreviewRequest(input: unknown): PreviewRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).some((key) => !REQUEST_KEYS.has(key))) throw new InvalidInput('Pedido de prévia inválido.');
  const { inventoryId, source, destination, mode } = input as Record<string, unknown>;
  const id = parseInventoryId(inventoryId);
  if (typeof source !== 'string' || !NODE_ID.test(source)) throw new InvalidInput(REFUSED_SOURCE);
  if (typeof destination !== 'string' || !NODE_ID.test(destination)) throw new InvalidInput(REFUSED_DESTINATION);
  if (mode !== undefined && mode !== 'folder' && mode !== 'folder-contents') throw new InvalidInput(REFUSED_MODE);
  return { inventoryId: id, source, destination, ...(mode ? { mode } : {}) };
}

export type DecisionRequest = { selection: PreviewRequest; proposalId: string; decision: HumanDecision; justification?: string };

const DECISION_KEYS = new Set(['selection', 'proposalId', 'decision', 'justification']);

/**
 * A janela só informa QUAL proposta e o que decidiu. O estado da proposta nunca vem daqui: o processo
 * principal refaz o plano a partir da seleção. O valor recebido nunca volta numa mensagem.
 */
export function parseDecisionRequest(input: unknown): DecisionRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).some((key) => !DECISION_KEYS.has(key))) throw new InvalidInput('Pedido de decisão inválido.');
  const { selection, proposalId, decision, justification } = input as Record<string, unknown>;
  const parsed = parsePreviewRequest(selection);
  if (!isProposalId(proposalId)) throw new InvalidInput('Proposta inválida. Gere a prévia de novo.');
  if (decision !== 'approved' && decision !== 'rejected') throw new InvalidInput('Decisão inválida: escolha aprovar ou rejeitar.');
  if (justification !== undefined && typeof justification !== 'string') throw new InvalidInput('Justificativa inválida.');
  const text = justification?.replace(/\r\n?/g, '\n').trim();
  if (text && text.length > MAX_JUSTIFICATION_LENGTH) throw new InvalidInput(`A justificativa pode ter até ${MAX_JUSTIFICATION_LENGTH} caracteres.`);
  if (text && !isValidJustification(text)) throw new InvalidInput('A justificativa tem caracteres não permitidos.');
  return { selection: parsed, proposalId, decision, ...(text ? { justification: text } : {}) };
}

/**
 * Transforma a escolha da janela, só com identificadores, numa seleção do motor. Recusa o que é
 * evidentemente inválido; nunca escolhe nem completa nada pelo operador.
 */
export function selectionFrom(tree: SelectionTree, input: { source?: unknown; destination?: unknown; mode?: unknown }): MovementSelection {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const source = typeof input.source === 'string' ? byId.get(input.source) : undefined;
  const destination = typeof input.destination === 'string' ? byId.get(input.destination) : undefined;
  if (!source || !source.canBeSource) throw new InvalidInput(REFUSED_SOURCE);
  if (!destination || destination.kind !== 'folder' || !destination.canBeDestination) throw new InvalidInput(REFUSED_DESTINATION);
  if (source.id === destination.id) throw new InvalidInput('A origem e o destino não podem ser a mesma pasta.');
  if (source.kind === 'folder') {
    for (let up: SelectionNode | undefined = destination; up; up = up.parent ? byId.get(up.parent) : undefined) {
      if (up.id === source.id) throw new InvalidInput('Uma pasta não pode ir para dentro de uma descendente.');
    }
  }
  const from = tree.selectors.get(source.id);
  const to = tree.selectors.get(destination.id);
  if (!from || !to || !('path' in to)) throw new InvalidInput(REFUSED_DESTINATION);
  if ('name' in from) return { kind: 'file', parent: from.parent, name: from.name, destination: to };
  if (input.mode !== 'folder' && input.mode !== 'folder-contents') throw new InvalidInput(REFUSED_MODE);
  return { kind: input.mode, source: from, destination: to };
}

export type ProposalIssueView = { code: string; message: string };

/** Proposta para a janela: lista fechada de campos, sem nomes, caminhos, assinaturas nem a seleção. */
export type ProposalPreview = {
  id: string;
  kind: MovementKind;
  state: MovementState;
  executable: false;
  authorizesChanges: false;
  source?: string;
  destination?: string;
  derivedPath: boolean;
  justification: string;
  alerts: string[];
  dependsOn: string[];
  parentOperation?: string;
  conflicts: ProposalIssueView[];
  blockers: ProposalIssueView[];
  group?: ConsolidationGroup;
  review: 'pending';
  /** Revisão do operador, conferida contra o plano atual. Não altera o estado acima nem autoriza nada. */
  decision: ProposalDecisionState;
};

/** Códigos do motor por categoria, para o resumo. Sem nomes. */
export function issueCategories(plan: MovementPlan): { conflicts: Record<string, number>; blockers: Record<string, number> } {
  const count = (codes: string[]) => {
    const totals: Record<string, number> = {};
    for (const code of [...codes].sort()) totals[code] = (totals[code] ?? 0) + 1;
    return totals;
  };
  return { conflicts: count(plan.proposals.flatMap((p) => p.conflicts.map((c) => c.code))), blockers: count(plan.proposals.flatMap((p) => p.blockers.map((b) => b.code))) };
}

/** Só apresentação dos códigos do motor. `Record` obriga a cobrir todo código novo do contrato. */
const CONFLICT_TEXT: Record<ConflictCode, string> = {
  'name-conflict': 'mesmo nome no destino',
  'equivalent-name-conflict': 'nome equivalente no destino',
  'nested-same-name': 'nível repetido',
  'source-claimed-twice': 'mesma origem em duas operações',
  'destination-collision': 'colisão no destino',
};
type ReasonGroup = 'security' | 'dependency' | 'other';
const BLOCKER_TEXT: Record<BlockerCode, { group: ReasonGroup; text: string }> = {
  'ambiguous-source': { group: 'security', text: 'origem ambígua' },
  'ambiguous-destination': { group: 'security', text: 'destino ambíguo' },
  'identity-inconsistent': { group: 'security', text: 'identidade inconsistente' },
  'unknown-item': { group: 'security', text: 'item de tipo desconhecido' },
  'root-move': { group: 'security', text: 'pasta inicial' },
  'move-into-self': { group: 'security', text: 'pasta para si mesma ou descendente' },
  'overlapping-consolidation': { group: 'security', text: 'consolidação em que uma pasta contém a outra' },
  'sector-not-identified': { group: 'security', text: 'setor não identificado' },
  'dependency-cycle': { group: 'dependency', text: 'ciclo de dependências' },
  'dependency-blocked': { group: 'dependency', text: 'depende de operação bloqueada' },
  'no-ready-operations': { group: 'dependency', text: 'nenhuma operação apta na consolidação' },
  'invalid-selection': { group: 'other', text: 'seleção inválida' },
  'source-not-found': { group: 'other', text: 'origem não encontrada' },
  'destination-not-found': { group: 'other', text: 'destino não encontrado' },
  'insufficient-data': { group: 'other', text: 'dados insuficientes' },
  'already-at-destination': { group: 'other', text: 'já está no destino' },
};
const GROUP_TITLE: Record<ReasonGroup, string> = { security: 'Bloqueios de segurança', dependency: 'Dependências não satisfeitas', other: 'Outros motivos' };

/**
 * Motivos de bloqueio do resumo, a partir do que o motor informou. Havendo proposta bloqueada sem
 * motivo informado, diz isso: nunca afirma que não há bloqueios. Sem nomes.
 */
export function blockingReasonLines(plan: MovementPlan): string[] {
  const { conflicts, blockers } = issueCategories(plan);
  const join = (entries: Array<[string, number]>) => entries.map(([text, n]) => `${text}: ${n}`).join(' · ');
  const lines: string[] = [];
  const conflictEntries = Object.entries(conflicts).map(([code, n]): [string, number] => [CONFLICT_TEXT[code as ConflictCode] ?? code, n]);
  if (conflictEntries.length) lines.push(`Conflitos: ${join(conflictEntries)}`);
  const known = Object.entries(blockers).map(([code, n]) => ({ code, n, info: BLOCKER_TEXT[code as BlockerCode] }));
  for (const group of ['security', 'dependency', 'other'] as const) {
    const entries = known.filter((k) => (k.info?.group ?? 'other') === group).map((k): [string, number] => [k.info?.text ?? k.code, k.n]);
    if (entries.length) lines.push(`${GROUP_TITLE[group]}: ${join(entries)}`);
  }
  if (lines.length === 0 && plan.summary.byState.blocked > 0) lines.push('Motivo não informado pelo motor: consulte cada proposta bloqueada.');
  return lines;
}

export function proposalPreviews(plan: MovementPlan, tree: SelectionTree, decisions: Map<string, ProposalDecisionState>): ProposalPreview[] {
  const issue = ({ code, message }: { code: string; message: string }): ProposalIssueView => ({ code, message });
  return plan.proposals.map((p) => {
    const source = p.source?.kind === 'folder' ? p.source.ref : p.source ? tree.fileIds.get(fileKey(p.source.parentRef, p.source.observationKey)) : undefined;
    const destination = p.destination?.folder.ref;
    const derived = [p.source, p.destination?.folder].some((i) => i?.kind === 'folder' && i.pathProvenance === 'derived-from-parent');
    return {
      id: p.id,
      kind: p.kind,
      state: p.state,
      executable: p.executable,
      authorizesChanges: p.authorizesChanges,
      ...(source ? { source } : {}),
      ...(destination ? { destination } : {}),
      derivedPath: derived,
      justification: p.justification,
      alerts: p.alerts,
      dependsOn: p.dependsOn,
      ...(p.parentOperation ? { parentOperation: p.parentOperation } : {}),
      conflicts: p.conflicts.map(issue),
      blockers: p.blockers.map(issue),
      ...(p.group ? { group: p.group } : {}),
      review: p.review.status,
      decision: decisions.get(p.id)!,
    };
  });
}
