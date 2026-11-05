import { createHash } from 'node:crypto';
import { canonicalJson } from './checkpoint.js';
import { normalizeName } from './duplicates.js';
import { planOrganization, type PlanOptions, type PlanValidation } from './organization-planner.js';
import { ENGINE_VERSION, byRef } from './structural-diagnostics.js';
import type { AirItem, FolderNode, FolderStatus, IdentityConfidence, TreeInventoryExport } from '../types/inventory.js';

/**
 * Motor de movimentações supervisionadas (POC-03A). DETERMINÍSTICO, local e somente leitura: sem
 * navegador, sem sistema de arquivos, sem rede. Recebe um inventário e as seleções explícitas do
 * operador (origem e destino) e devolve PROPOSTAS para revisão humana (ARCHITECTURE.md §9.3).
 *
 * - Nenhuma proposta é executável: não há executor, e o formato não tem comandos, URLs nem seletores.
 * - Não existe operação de exclusão, substituição, sobrescrita ou criação de pasta.
 * - A elegibilidade do inventário é a do planejador (`planOrganization`): selo, estrutura,
 *   completude e idade conferidos de novo. Qualquer dúvida = plano recusado, sem propostas.
 * - Só os metadados da listagem são usados: mesmo nome nunca é tratado como mesmo conteúdo.
 * - Dúvida sobre uma operação = proposta bloqueada, nunca uma escolha implícita.
 *
 * Mesmo inventário + mesmas seleções (em qualquer ordem) + mesmo `now` = mesmo plano, byte a byte.
 * O plano não é autenticado: não serve de fonte para uma execução futura sem nova leitura.
 */

export const MOVEMENT_PLAN_FORMAT = 'air-organizer/movement-plan';
export const MOVEMENT_PLANNER_VERSION = '1';

/* ───────────── Pedido do operador ───────────── */

/**
 * `path` identifica a pasta; `ref`, quando informado, é só uma conferência: as referências F<n> mudam
 * entre leituras e nunca desempatam homônimos.
 */
export type FolderSelector = { path: string; ref?: string };

export type MovementSelection =
  /** Mover um arquivo para a pasta de destino. */
  | { kind: 'file'; parent: FolderSelector; name: string; destination: FolderSelector }
  /** Levar a pasta para dentro do destino. Se ele já tiver subpasta homônima, consolida nela. */
  | { kind: 'folder'; source: FolderSelector; destination: FolderSelector }
  /** Consolidar o conteúdo da origem no próprio destino, escolhido pelo operador (os nomes podem diferir). */
  | { kind: 'folder-contents'; source: FolderSelector; destination: FolderSelector };

export type MovementRequest = { selections: MovementSelection[] };

/* ───────────── Contratos da proposta ───────────── */

/**
 * 'consolidate-folder' é lógica: registra o par origem → pasta existente que recebe o conteúdo. A
 * pasta de origem permanece, e a de destino é reaproveitada: nenhuma pasta é criada nem removida.
 */
export type MovementKind = 'move-file' | 'move-folder' | 'consolidate-folder';

/**
 * 'generated': saída de `generateMovementProposals`, ainda sem as verificações entre operações.
 * 'blocked' e 'ready-for-review': resultado de `assessMovementProposals`; é o que um plano contém.
 * Não há estado executável: "apta para revisão" não autoriza nada.
 */
export type MovementState = 'generated' | 'blocked' | 'ready-for-review';

/** Choque de nomes ou entre operações. Sem nomes nas mensagens. */
export type ConflictCode = 'name-conflict' | 'equivalent-name-conflict' | 'nested-same-name' | 'source-claimed-twice' | 'destination-collision';

/** Dado insuficiente, identidade duvidosa ou regra de segurança. Sem nomes nas mensagens. */
export type BlockerCode =
  | 'invalid-selection'
  | 'source-not-found'
  | 'destination-not-found'
  | 'ambiguous-source'
  | 'ambiguous-destination'
  | 'identity-inconsistent'
  | 'insufficient-data'
  | 'unknown-item'
  | 'root-move'
  | 'move-into-self'
  | 'overlapping-consolidation'
  | 'already-at-destination'
  | 'sector-not-identified'
  | 'dependency-cycle'
  | 'dependency-blocked'
  /** Consolidação em que nenhuma operação derivada está apta. */
  | 'no-ready-operations';

export type MovementIssue<Code extends string> = {
  code: Code;
  message: string;
  /** Pastas F<n> envolvidas. */
  refs?: string[];
  relatedOperations?: string[];
};

/**
 * De onde veio o caminho da pasta. 'observed': gravado pela leitura. 'derived-from-parent': pasta vazia
 * (sem linhas, não há coluna "Caminho"), calculado do pai e do nome por `deriveEmptyFolderPaths`.
 */
export type PathProvenance = 'observed' | 'derived-from-parent';

export type FolderIdentity = { kind: 'folder'; ref: string; parentRef?: string; depth: number; name?: string; path?: string; pathProvenance?: PathProvenance };

/** Sem ID do AIR: a identidade é a linha observada na pasta que a contém. */
export type FileIdentity = { kind: 'file'; parentRef: string; identityConfidence: IdentityConfidence; sourcePage: number; rowIndex: number; observationKey?: string; name?: string; path?: string };

export type ListingEvidence = { ref: string; status: FolderStatus; items: number; folders: number; files: number; pagesRead: number };

export type MovementEvidence = {
  /** Identidade do inventário autenticado (hash; não expõe o selo). */
  inventoryId: string;
  /** 'operator-selection': pedida pelo operador. 'consolidation': derivada de uma consolidação. */
  origin: 'operator-selection' | 'consolidation';
  /** Só listagens foram comparadas: 'metadata-only' lembra que nenhum conteúdo foi aberto. */
  comparison: 'metadata-only';
  sourceListing?: ListingEvidence;
  destinationListing?: ListingEvidence;
  /** Só em 'move-folder': o que a pasta leva, conforme o inventário. */
  subtree?: { folders: number; files: number };
};

/**
 * Situação de um agrupamento 'consolidate-folder', considerando todas as operações derivadas.
 * 'all-ready': todas aptas. 'partially-blocked': há aptas e bloqueadas. 'fully-blocked': nenhuma apta
 * (a própria consolidação fica bloqueada). 'empty': a origem não tem o que consolidar.
 */
export type ConsolidationStatus = 'all-ready' | 'partially-blocked' | 'fully-blocked' | 'empty';

/**
 * Agrupar não aprova: uma consolidação, mesmo apta para revisão, nunca libera as operações derivadas
 * dela. Cada uma tem estado e revisão próprios, e as bloqueadas continuam bloqueadas.
 */
export type ConsolidationGroup = {
  status: ConsolidationStatus;
  authorizesOperations: false;
  /** Operações derivadas, em todos os níveis. */
  readyOperations: string[];
  blockedOperations: string[];
};

export type HumanReview = { status: 'pending'; required: true; decidedBy: null; decidedAt: null };

export type MovementProposal = {
  /** Estável para o mesmo inventário autenticado: versão, inventário, tipo, origem e destino. */
  id: string;
  kind: MovementKind;
  state: MovementState;
  executable: false;
  authorizesChanges: false;
  /** Ausente quando a origem não pôde ser identificada com segurança. */
  source?: FolderIdentity | FileIdentity;
  /** Ausente quando o destino não pôde ser identificado com segurança. */
  destination?: { folder: FolderIdentity; resultingPath?: string };
  /** A seleção, quando origem ou destino não foram resolvidos. Identificável. */
  requested?: unknown;
  /** Sem nomes. */
  justification: string;
  /** Avisos que não bloqueiam. Sem nomes. */
  alerts: string[];
  dependsOn: string[];
  /** Consolidação que originou esta operação. */
  parentOperation?: string;
  /** Só em 'consolidate-folder', depois da avaliação. */
  group?: ConsolidationGroup;
  conflicts: MovementIssue<ConflictCode>[];
  blockers: MovementIssue<BlockerCode>[];
  evidence: MovementEvidence;
  review: HumanReview;
};

export type MovementPlan = {
  kind: typeof MOVEMENT_PLAN_FORMAT;
  schemaVersion: 1;
  plannerVersion: string;
  engineVersion: string;
  identifiable: boolean;
  generatedAt: string;
  dryRun: true;
  executable: false;
  authorizesChanges: false;
  authenticated: false;
  notices: string[];
  source: { runId?: string; checkpointRunId?: string; finishedAt?: string; sealedAt?: string; inventoryId?: string };
  validation: PlanValidation;
  summary: {
    selections: number;
    proposals: number;
    byState: Record<MovementState, number>;
    byKind: Record<MovementKind, number>;
    consolidations: Record<ConsolidationStatus, number>;
    conflicts: number;
    blockers: number;
    /** Itens da listagem envolvidos em alguma proposta (inclusive o que uma pasta movida leva). */
    items: { inventory: number; involved: number; notInvolved: number };
  };
  /** Ordem segura de REVISÃO das propostas aptas, respeitando as dependências. Não é um roteiro de execução. */
  safeOrder: string[];
  proposals: MovementProposal[];
};

export const MOVEMENT_NOTICES = [
  'Propostas para revisão humana: nenhuma é executável nem autoriza mover nada no AIR.',
  'Só metadados da listagem foram comparados: mesmo nome não indica mesmo conteúdo, e nenhum documento foi aberto.',
  'Não há proposta de exclusão, substituição ou sobrescrita. As pastas de origem de uma consolidação permanecem, mesmo que fiquem vazias.',
  'Uma consolidação só agrupa operações: não aprova nem libera nenhuma delas, e as bloqueadas continuam bloqueadas.',
  'Antes de qualquer execução futura, a origem e o destino precisam ser revalidados no AIR, inclusive os caminhos derivados.',
  'Este plano não é autenticado: não use como fonte para uma execução futura sem nova leitura e revalidação.',
  'O AIR pode ter mudado desde a leitura.',
];

const REVIEW: HumanReview = { status: 'pending', required: true, decidedBy: null, decidedAt: null };

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const plural = (n: number, singular: string, many: string) => `${n} ${n === 1 ? singular : many}`;

/* ───────────── Índice do inventário ───────────── */

type InventoryIndex = {
  folders: Map<string, FolderNode>;
  byPath: Map<string, FolderNode[]>;
  kids: Map<string, FolderNode[]>;
  /** Linha de cada subpasta na listagem do pai. */
  row: Map<string, AirItem>;
  pageUrls: Map<string, number>;
  /** Observações por pasta (`ref` + `observationKey`). */
  observations: Map<string, number>;
  /** Pastas cujo caminho foi derivado. */
  derived: Set<string>;
  /** Pastas existentes cuja derivação foi recusada, pelo caminho que teriam. */
  underivable: Map<string, Array<{ ref: string; reason: PathDerivationRefusal }>>;
};

const increment = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
const observation = (parentRef: string, item: AirItem) => `${parentRef}\u0000${item.observationKey}`;

function buildIndex(sorted: FolderNode[]): InventoryIndex {
  const idx: InventoryIndex = { folders: new Map(), byPath: new Map(), kids: new Map(), row: new Map(), pageUrls: new Map(), observations: new Map(), derived: new Set(), underivable: new Map() };
  for (const f of sorted) {
    idx.folders.set(f.ref, f);
    if (f.path !== undefined) idx.byPath.set(f.path, [...(idx.byPath.get(f.path) ?? []), f]);
    if (f.parentRef) idx.kids.set(f.parentRef, [...(idx.kids.get(f.parentRef) ?? []), f]);
    if (f.pageUrl) increment(idx.pageUrls, f.pageUrl);
    for (const item of f.items) increment(idx.observations, observation(f.ref, item));
  }
  for (const f of sorted) {
    const kids = idx.kids.get(f.ref) ?? [];
    f.items.filter((i) => i.kind === 'folder').forEach((item, i) => {
      if (kids[i]) idx.row.set(kids[i].ref, item);
    });
  }
  return idx;
}

export type PathDerivationRefusal =
  | 'no-parent'
  | 'unsafe-name'
  | 'not-empty'
  | 'not-confirmed'
  | 'no-navigation-evidence'
  | 'parent-unknown'
  | 'parent-ambiguous'
  | 'no-parent-row'
  | 'row-unconfirmed'
  | 'sibling-ambiguous'
  | 'path-collision';

const REFUSAL_TEXT: Record<PathDerivationRefusal, string> = {
  'no-parent': 'é a pasta inicial',
  'unsafe-name': 'o nome está ausente ou não pode compor um caminho',
  'not-empty': 'a pasta não está vazia',
  'not-confirmed': 'a leitura da pasta não está completa',
  'no-navigation-evidence': 'não há URL observada exclusiva da pasta',
  'parent-unknown': 'a pasta pai não tem caminho ou leitura completa',
  'parent-ambiguous': 'o caminho do pai passa por pastas homônimas',
  'no-parent-row': 'não há linha correspondente, com o mesmo nome, na listagem do pai',
  'row-unconfirmed': 'a linha no pai não confirma o caminho do pai',
  'sibling-ambiguous': 'há item com nome igual ou equivalente na mesma pasta',
  'path-collision': 'o caminho resultante já pertence a outra pasta',
};

function refusalFor(idx: InventoryIndex, f: FolderNode): PathDerivationRefusal | undefined {
  if (!f.parentRef) return 'no-parent';
  const name = f.name;
  if (name === undefined || name.trim() === '' || name.includes('/')) return 'unsafe-name';
  if (f.items.length > 0 || f.counts.items > 0 || (idx.kids.get(f.ref)?.length ?? 0) > 0) return 'not-empty';
  if (f.status !== 'complete' || f.subtreeStatus !== 'complete' || f.reasons.length > 0 || f.reusedFrom !== undefined) return 'not-confirmed';
  if (!f.pageUrl || (idx.pageUrls.get(f.pageUrl) ?? 0) > 1) return 'no-navigation-evidence';
  const parent = idx.folders.get(f.parentRef);
  if (!parent || parent.path === undefined || parent.status !== 'complete') return 'parent-unknown';
  if ([...lineage(idx, parent.ref)].some((a) => a.path !== undefined && (idx.byPath.get(a.path)?.length ?? 0) > 1)) return 'parent-ambiguous';
  const row = idx.row.get(f.ref);
  if (!row || row.kind !== 'folder' || row.name !== name) return 'no-parent-row';
  if (row.identityConfidence === 'ambiguous' || row.path !== parent.path) return 'row-unconfirmed';
  const wanted = normalizeName(name);
  if (parent.items.some((i) => i !== row && normalizeName(i.name) === wanted)) return 'sibling-ambiguous';
  if (idx.byPath.has(`${parent.path}/${name}`)) return 'path-collision';
  return undefined;
}

/**
 * Caminho das subpastas vazias: sem linhas, a leitura não tem coluna "Caminho" de onde tirá-lo. Só
 * deriva de uma pasta QUE EXISTE no inventário, aberta pela leitura, com linha de mesmo nome no pai,
 * pai inequívoco e nenhum irmão de nome igual ou equivalente. Um caminho construído nunca prova que a
 * pasta existe: só se parte de nós do inventário. Na dúvida, recusa e informa o motivo.
 *
 * Só afeta o índice em memória do motor: não muda o inventário, o selo nem a completude.
 */
export function deriveEmptyFolderPaths(inv: TreeInventoryExport): { derived: Map<string, string>; refused: Map<string, PathDerivationRefusal> } {
  const idx = buildIndex([...inv.folders].sort(byRef));
  const derived = new Map<string, string>();
  const refused = new Map<string, PathDerivationRefusal>();
  for (const f of idx.folders.values()) {
    if (f.path !== undefined) continue;
    const refusal = refusalFor(idx, f);
    if (refusal) refused.set(f.ref, refusal);
    else derived.set(f.ref, `${idx.folders.get(f.parentRef!)!.path}/${f.name}`);
  }
  return { derived, refused };
}

function indexInventory(inv: TreeInventoryExport): InventoryIndex {
  const { derived, refused } = deriveEmptyFolderPaths(inv);
  // Cópias: o inventário recebido não muda.
  const idx = buildIndex([...inv.folders].sort(byRef).map((f) => (derived.has(f.ref) ? { ...f, path: derived.get(f.ref)! } : f)));
  idx.derived = new Set(derived.keys());
  for (const [ref, reason] of refused) {
    const f = idx.folders.get(ref)!;
    const parentPath = f.parentRef ? idx.folders.get(f.parentRef)?.path : undefined;
    if (parentPath === undefined || f.name === undefined) continue;
    const would = `${parentPath}/${f.name}`;
    idx.underivable.set(would, [...(idx.underivable.get(would) ?? []), { ref, reason }]);
  }
  return idx;
}

/** A pasta e seus ancestrais, da própria pasta até a raiz. */
function* lineage(idx: InventoryIndex, ref: string | undefined): Generator<FolderNode> {
  for (let f = ref ? idx.folders.get(ref) : undefined; f; f = f.parentRef ? idx.folders.get(f.parentRef) : undefined) yield f;
}

const isSameOrInside = (idx: InventoryIndex, ref: string, ancestor: string) => [...lineage(idx, ref)].some((f) => f.ref === ancestor);

function subtreeOf(idx: InventoryIndex, root: FolderNode): FolderNode[] {
  const nodes: FolderNode[] = [];
  const stack = [root];
  while (stack.length) {
    const f = stack.pop()!;
    nodes.push(f);
    stack.push(...(idx.kids.get(f.ref) ?? []));
  }
  return nodes;
}

/* ───────────── Identidade ───────────── */

type Role = 'source' | 'destination';
const ROLE_TEXT: Record<Role, string> = { source: 'origem', destination: 'destino' };
const ambiguous = (role: Role): BlockerCode => (role === 'source' ? 'ambiguous-source' : 'ambiguous-destination');
const notFound = (role: Role): BlockerCode => (role === 'source' ? 'source-not-found' : 'destination-not-found');

/** Identidade conferida a partir do inventário, sem presumir que o caminho sozinho prova a pasta. */
function folderIdentityIssues(idx: InventoryIndex, f: FolderNode, role: Role): MovementIssue<BlockerCode>[] {
  const issues: MovementIssue<BlockerCode>[] = [];
  const refs = [f.ref];
  const text = ROLE_TEXT[role];
  if (f.name === undefined || f.path === undefined || !f.pageUrl) {
    issues.push({ code: 'insufficient-data', message: `Pasta de ${text} sem nome, caminho ou URL observada no inventário.`, refs });
  }
  if (f.pageUrl && (idx.pageUrls.get(f.pageUrl) ?? 0) > 1) {
    issues.push({ code: 'identity-inconsistent', message: `Pasta de ${text} com a mesma URL observada de outra pasta do inventário.`, refs });
  }
  // Um homônimo em qualquer nível torna o caminho ambíguo, mesmo que a pasta final seja única.
  if ([...lineage(idx, f.ref)].some((a) => a.path !== undefined && (idx.byPath.get(a.path)?.length ?? 0) > 1)) {
    issues.push({ code: ambiguous(role), message: `Caminho de ${text} passa por pastas homônimas: a identidade não é comprovável.`, refs });
  }
  const row = idx.row.get(f.ref);
  if (f.parentRef) {
    const parentPath = idx.folders.get(f.parentRef)?.path;
    if (!row) issues.push({ code: 'insufficient-data', message: `Pasta de ${text} sem linha correspondente na listagem do pai.`, refs });
    else if (row.identityConfidence === 'ambiguous') issues.push({ code: ambiguous(role), message: `Linha da pasta de ${text} sem caminho nem data: identidade ambígua.`, refs });
    else if (row.path !== undefined && row.path !== parentPath) issues.push({ code: 'identity-inconsistent', message: `Linha da pasta de ${text} aponta para outro ramo.`, refs });
  }
  return issues;
}

function fileIdentityIssues(idx: InventoryIndex, parent: FolderNode, item: AirItem): MovementIssue<BlockerCode>[] {
  const issues: MovementIssue<BlockerCode>[] = [];
  const refs = [parent.ref];
  if (item.identityConfidence === 'ambiguous') issues.push({ code: 'ambiguous-source', message: 'Linha do arquivo sem caminho nem data: identidade ambígua.', refs });
  if ((idx.observations.get(observation(parent.ref, item)) ?? 0) > 1) issues.push({ code: 'identity-inconsistent', message: 'Mais de uma linha da pasta com a mesma assinatura observada.', refs });
  if (item.path === undefined) issues.push({ code: 'insufficient-data', message: 'Arquivo sem caminho na listagem.', refs });
  else if (item.path !== parent.path) issues.push({ code: 'identity-inconsistent', message: 'Linha do arquivo aponta para outro ramo.', refs });
  return issues;
}

type Resolved = { folder: FolderNode; issues: MovementIssue<BlockerCode>[] } | { folder?: undefined; issues: MovementIssue<BlockerCode>[] };

/** Só correspondência exata de caminho. Homônimos nunca são desempatados, nem por `ref`. */
function resolveFolder(idx: InventoryIndex, selector: FolderSelector, role: Role): Resolved {
  const text = ROLE_TEXT[role];
  const candidates = idx.byPath.get(selector.path) ?? [];
  if (candidates.length > 1) return { issues: [{ code: ambiguous(role), message: `${candidates.length} pastas com o mesmo caminho de ${text}: identidade ambígua, sem desempate.`, refs: candidates.map((f) => f.ref) }] };
  const folder = candidates[0];
  if (!folder) {
    const refused = idx.underivable.get(selector.path);
    if (refused) {
      const refs = refused.map((r) => r.ref);
      if (refused.length > 1 || refused[0]!.reason === 'sibling-ambiguous' || refused[0]!.reason === 'parent-ambiguous') {
        return { issues: [{ code: ambiguous(role), message: `Pasta de ${text} sem caminho gravado, com identidade ambígua: ${REFUSAL_TEXT[refused[0]!.reason]}.`, refs }] };
      }
      return { issues: [{ code: 'insufficient-data', message: `Pasta de ${text} sem caminho comprovável: ${REFUSAL_TEXT[refused[0]!.reason]}.`, refs }] };
    }
    if (selector.ref && idx.folders.has(selector.ref)) return { issues: [{ code: 'identity-inconsistent', message: `A referência informada existe, mas com outro caminho de ${text}.`, refs: [selector.ref] }] };
    const wanted = normalizeName(selector.path);
    const similar = [...idx.byPath.keys()].filter((p) => normalizeName(p) === wanted).length;
    const hint = similar ? ` ${plural(similar, 'caminho é equivalente', 'caminhos são equivalentes')} só após normalização: confirme e selecione o caminho exato.` : ' Nenhuma pasta é criada implicitamente.';
    return { issues: [{ code: notFound(role), message: `Pasta de ${text} não existe no inventário.${hint}` }] };
  }
  if (selector.ref && selector.ref !== folder.ref) return { issues: [{ code: 'identity-inconsistent', message: `A referência informada não corresponde ao caminho de ${text}.`, refs: [folder.ref, selector.ref] }] };
  return { folder, issues: folderIdentityIssues(idx, folder, role) };
}

const folderIdentity = (idx: InventoryIndex, f: FolderNode): FolderIdentity => ({
  kind: 'folder',
  ref: f.ref,
  ...(f.parentRef ? { parentRef: f.parentRef } : {}),
  depth: f.depth,
  ...(f.name !== undefined ? { name: f.name } : {}),
  ...(f.path !== undefined ? { path: f.path, pathProvenance: idx.derived.has(f.ref) ? ('derived-from-parent' as const) : ('observed' as const) } : {}),
});

const fileIdentity = (parent: FolderNode, item: AirItem): FileIdentity => ({
  kind: 'file',
  parentRef: parent.ref,
  identityConfidence: item.identityConfidence,
  sourcePage: item.sourcePage,
  rowIndex: item.rowIndex,
  observationKey: item.observationKey,
  name: item.name,
  ...(parent.path !== undefined ? { path: `${parent.path}/${item.name}` } : {}),
});

const listing = (f: FolderNode): ListingEvidence => ({ ref: f.ref, status: f.status, items: f.counts.items, folders: f.counts.folders, files: f.counts.files, pagesRead: f.counts.pagesRead });

/* ───────────── Geração ───────────── */

const sourceKey = (s: FolderIdentity | FileIdentity) => (s.kind === 'folder' ? `folder:${s.ref}` : `file:${s.parentRef}:${s.observationKey}`);

function operationId(inventoryId: string, kind: MovementKind, source: string, destination: string): string {
  return `M-${sha(`${MOVEMENT_PLAN_FORMAT}/v${MOVEMENT_PLANNER_VERSION}|${inventoryId}|${kind}|${source}|${destination}`).slice(0, 16)}`;
}

class ProposalBuilder {
  readonly proposals = new Map<string, MovementProposal>();
  readonly idx: InventoryIndex;

  constructor(
    inv: TreeInventoryExport,
    private readonly inventoryId: string,
  ) {
    this.idx = indexInventory(inv);
  }

  private add(p: Omit<MovementProposal, 'id' | 'state' | 'executable' | 'authorizesChanges' | 'dependsOn' | 'review'>, idSource: string, idDestination: string): MovementProposal {
    const id = operationId(this.inventoryId, p.kind, idSource, idDestination);
    const existing = this.proposals.get(id);
    if (existing) {
      // A mesma operação pedida duas vezes é uma só; os impedimentos encontrados em cada caminho somam.
      for (const c of p.conflicts) if (!existing.conflicts.some((e) => e.code === c.code)) existing.conflicts.push(c);
      for (const b of p.blockers) if (!existing.blockers.some((e) => e.code === b.code)) existing.blockers.push(b);
      if (p.parentOperation) existing.parentOperation ??= p.parentOperation;
      return existing;
    }
    const proposal: MovementProposal = { id, state: 'generated', executable: false, authorizesChanges: false, dependsOn: [], review: REVIEW, ...p };
    for (const identity of [p.source, p.destination?.folder]) {
      if (identity?.kind === 'folder' && identity.pathProvenance === 'derived-from-parent') {
        proposal.alerts = [...proposal.alerts, `Caminho da pasta ${identity.ref} derivado do pai e do nome (pasta vazia, sem coluna "Caminho"): reconfirme a pasta no AIR.`];
      }
    }
    this.proposals.set(id, proposal);
    return proposal;
  }

  private evidence(origin: MovementEvidence['origin'], source?: FolderNode, destination?: FolderNode, subtree?: MovementEvidence['subtree']): MovementEvidence {
    return {
      inventoryId: this.inventoryId,
      origin,
      comparison: 'metadata-only',
      ...(source ? { sourceListing: listing(source) } : {}),
      ...(destination ? { destinationListing: listing(destination) } : {}),
      ...(subtree ? { subtree } : {}),
    };
  }

  /** O que o destino já tem com esse nome: idêntico, ou equivalente só após normalização. */
  private namesIn(destination: FolderNode, name: string): { exact: AirItem[]; equivalent: AirItem[] } {
    const wanted = normalizeName(name);
    const exact = destination.items.filter((i) => i.name === name);
    return { exact, equivalent: destination.items.filter((i) => i.name !== name && normalizeName(i.name) === wanted) };
  }

  private destinationField(destination: FolderNode, name: string | undefined): MovementProposal['destination'] {
    return { folder: folderIdentity(this.idx, destination), ...(destination.path !== undefined && name !== undefined ? { resultingPath: `${destination.path}/${name}` } : {}) };
  }

  placeFile(parent: FolderNode, item: AirItem, destination: FolderNode, origin: MovementEvidence['origin'], parentOperation?: string): void {
    const conflicts: MovementIssue<ConflictCode>[] = [];
    const blockers = [...fileIdentityIssues(this.idx, parent, item), ...(origin === 'operator-selection' ? folderIdentityIssues(this.idx, destination, 'destination') : [])];
    const refs = [destination.ref];
    if (parent.ref === destination.ref) {
      blockers.push({ code: 'already-at-destination', message: 'O arquivo já está na pasta de destino.', refs });
    } else {
      const { exact, equivalent } = this.namesIn(destination, item.name);
      if (exact.length) conflicts.push({ code: 'name-conflict', message: 'O destino já tem item com o mesmo nome. Mesmo nome não prova mesmo conteúdo, e nada é substituído: exige decisão humana.', refs });
      else if (equivalent.length) conflicts.push({ code: 'equivalent-name-conflict', message: 'O destino tem item com nome equivalente após normalização: exige decisão humana.', refs });
    }
    const source = fileIdentity(parent, item);
    this.add(
      {
        kind: 'move-file',
        source,
        destination: this.destinationField(destination, item.name),
        justification:
          origin === 'consolidation'
            ? `Arquivo da pasta ${parent.ref} a levar para a pasta correspondente ${destination.ref}, nesta consolidação.`
            : `Arquivo da pasta ${parent.ref} selecionado pelo operador para a pasta ${destination.ref}.`,
        alerts: [],
        ...(parentOperation ? { parentOperation } : {}),
        conflicts,
        blockers,
        evidence: this.evidence(origin, parent, destination),
      },
      sourceKey(source),
      `folder:${destination.ref}`,
    );
  }

  /** Pasta para dentro de `destination`: consolida na homônima existente ou move a pasta inteira. */
  placeFolder(folder: FolderNode, destination: FolderNode, origin: MovementEvidence['origin'], parentOperation?: string): void {
    const name = folder.name;
    const { exact, equivalent } = name !== undefined ? this.namesIn(destination, name) : { exact: [], equivalent: [] };
    const explicit = origin === 'operator-selection';
    const blockers: MovementIssue<BlockerCode>[] = [];
    const conflicts: MovementIssue<ConflictCode>[] = [];
    const refs = [folder.ref, destination.ref];

    if (!folder.parentRef) blockers.push({ code: 'root-move', message: 'A pasta inicial do inventário nunca é movida.', refs });
    if (isSameOrInside(this.idx, destination.ref, folder.ref)) blockers.push({ code: 'move-into-self', message: 'Uma pasta não pode ser movida para si mesma nem para uma descendente.', refs });
    else if (folder.parentRef === destination.ref) blockers.push({ code: 'already-at-destination', message: 'A pasta já está na pasta de destino.', refs });

    if (explicit) blockers.push(...folderIdentityIssues(this.idx, destination, 'destination'));

    if (blockers.length === 0 && exact.length === 1 && exact[0]!.kind === 'folder') {
      const counterpart = (this.idx.kids.get(destination.ref) ?? []).find((k) => k.name === name);
      if (counterpart) return this.consolidate(folder, counterpart, origin, parentOperation);
    }
    if (exact.length > 1) blockers.push({ code: 'ambiguous-destination', message: `${exact.length} itens com o mesmo nome no destino: não há como escolher a pasta correspondente.`, refs });
    else if (exact.length === 1 && exact[0]!.kind !== 'folder') conflicts.push({ code: 'name-conflict', message: 'O destino tem um item que não é pasta com o mesmo nome: exige decisão humana.', refs });
    else if (exact.length === 0 && equivalent.length) conflicts.push({ code: 'equivalent-name-conflict', message: 'O destino tem item com nome equivalente após normalização: a correspondência exige confirmação (use a consolidação explícita, se for a mesma categoria).', refs });

    // `.../2025` para dentro de `.../2025` criaria um nível repetido: quase sempre o pedido era consolidar.
    if (explicit && exact.length === 0 && name !== undefined && destination.name === name) {
      conflicts.push({ code: 'nested-same-name', message: 'O destino tem o mesmo nome da pasta: mover criaria um nível repetido. Para reunir o conteúdo, selecione a consolidação do conteúdo.', refs });
    }

    const subtree = subtreeOf(this.idx, folder);
    const unknown = subtree.reduce((sum, f) => sum + f.counts.unknown, 0);
    if (unknown) blockers.push({ code: 'unknown-item', message: `A pasta leva ${plural(unknown, 'item de tipo desconhecido', 'itens de tipo desconhecido')}.`, refs: [folder.ref] });
    blockers.push(...folderIdentityIssues(this.idx, folder, 'source'));

    const source = folderIdentity(this.idx, folder);
    this.add(
      {
        kind: 'move-folder',
        source,
        destination: this.destinationField(destination, name),
        justification: explicit
          ? `Pasta ${folder.ref} selecionada pelo operador para a pasta ${destination.ref}, sem subpasta correspondente no destino; a hierarquia interna é preservada.`
          : `Subpasta ${folder.ref} sem correspondente na pasta ${destination.ref}; vai inteira, preservando a hierarquia interna.`,
        alerts: [],
        ...(parentOperation ? { parentOperation } : {}),
        conflicts,
        blockers,
        evidence: this.evidence(origin, folder, destination, { folders: subtree.length - 1, files: subtree.reduce((sum, f) => sum + f.counts.files, 0) }),
      },
      sourceKey(source),
      `folder:${destination.ref}`,
    );
  }

  /** Reúne o conteúdo de `source` na pasta existente `target`, recursivamente. Nenhuma pasta é criada. */
  consolidate(source: FolderNode, target: FolderNode, origin: MovementEvidence['origin'], parentOperation?: string): void {
    const refs = [source.ref, target.ref];
    const blockers: MovementIssue<BlockerCode>[] = [];
    if (isSameOrInside(this.idx, source.ref, target.ref) || isSameOrInside(this.idx, target.ref, source.ref)) {
      blockers.push({ code: 'overlapping-consolidation', message: 'Origem e destino são a mesma pasta ou uma contém a outra: a consolidação não é segura.', refs });
    }
    blockers.push(...folderIdentityIssues(this.idx, source, 'source'), ...folderIdentityIssues(this.idx, target, 'destination'));
    const unknown = source.items.filter((i) => i.kind === 'unknown').length;
    if (unknown) blockers.push({ code: 'unknown-item', message: `A pasta de origem tem ${plural(unknown, 'item de tipo desconhecido', 'itens de tipo desconhecido')}.`, refs: [source.ref] });
    const sameName = source.name === target.name;
    const proposal = this.add(
      {
        kind: 'consolidate-folder',
        source: folderIdentity(this.idx, source),
        destination: this.destinationField(target, undefined),
        justification: sameName
          ? `Pastas ${source.ref} e ${target.ref} têm o mesmo nome: o conteúdo seria reunido na existente, sem criar outra pasta. O nome não prova que sejam a mesma categoria.`
          : `Consolidação explícita do conteúdo da pasta ${source.ref} na pasta ${target.ref}, escolhidas pelo operador.`,
        alerts: ['A pasta de origem permanece, mesmo que fique vazia: nenhuma exclusão é proposta.'],
        ...(parentOperation ? { parentOperation } : {}),
        conflicts: [],
        blockers,
        evidence: this.evidence(origin, source, target),
      },
      sourceKey(folderIdentity(this.idx, source)),
      `folder:${target.ref}`,
    );
    if (blockers.length) return; // sem base segura para percorrer o conteúdo
    const kids = this.idx.kids.get(source.ref) ?? [];
    let kid = 0;
    for (const item of source.items) {
      if (item.kind === 'file') this.placeFile(source, item, target, 'consolidation', proposal.id);
      else if (item.kind === 'folder') {
        const node = kids[kid++];
        if (node) this.placeFolder(node, target, 'consolidation', proposal.id);
      }
    }
  }

  /** Seleção que não chegou a resolver origem e destino: fica registrada como bloqueada. */
  unresolved(selection: unknown, kind: MovementKind, source: FolderNode | undefined, sourceIdentity: FolderIdentity | FileIdentity | undefined, destination: FolderNode | undefined, blockers: MovementIssue<BlockerCode>[]): void {
    const key = sha(canonicalJson(selection));
    this.add(
      {
        kind,
        ...(sourceIdentity ? { source: sourceIdentity } : {}),
        ...(destination ? { destination: this.destinationField(destination, undefined) } : {}),
        requested: selection,
        justification: 'Seleção do operador sem origem ou destino identificados com segurança.',
        alerts: [],
        conflicts: [],
        blockers,
        evidence: this.evidence('operator-selection', source, destination),
      },
      `selection:${key}`,
      `selection:${key}`,
    );
  }

  select(selection: MovementSelection): void {
    if (!isValidSelection(selection)) {
      this.unresolved(selection, 'move-file', undefined, undefined, undefined, [{ code: 'invalid-selection', message: 'Seleção malformada: faltam origem, destino ou tipo válidos.' }]);
      return;
    }
    const destination = resolveFolder(this.idx, selection.destination, 'destination');
    if (selection.kind === 'file') {
      const parent = resolveFolder(this.idx, selection.parent, 'source');
      const named = parent.folder?.items.filter((i) => i.name === selection.name) ?? [];
      const blockers = [...parent.issues];
      if (parent.folder && named.length === 0) blockers.push({ code: 'source-not-found', message: 'Item não existe na listagem da pasta de origem.', refs: [parent.folder.ref] });
      if (named.length > 1) blockers.push({ code: 'ambiguous-source', message: `${named.length} itens com o mesmo nome na pasta de origem: nome não distingue qual mover.`, refs: [parent.folder!.ref] });
      const item = named.length === 1 ? named[0]! : undefined;
      if (item && item.kind !== 'file') blockers.push({ code: item.kind === 'unknown' ? 'unknown-item' : 'identity-inconsistent', message: item.kind === 'unknown' ? 'Item de tipo desconhecido não é tratado como arquivo.' : 'O item selecionado como arquivo é uma pasta.', refs: [parent.folder!.ref] });
      if (!parent.folder || !destination.folder || !item || item.kind !== 'file' || parent.issues.length) {
        const identity = parent.folder && item?.kind === 'file' ? fileIdentity(parent.folder, item) : undefined;
        this.unresolved(selection, 'move-file', parent.folder, identity, destination.folder, [...blockers, ...destination.issues]);
        return;
      }
      this.placeFile(parent.folder, item, destination.folder, 'operator-selection');
      return;
    }
    const source = resolveFolder(this.idx, selection.source, 'source');
    if (!source.folder || !destination.folder) {
      const kind: MovementKind = selection.kind === 'folder' ? 'move-folder' : 'consolidate-folder';
      this.unresolved(selection, kind, source.folder, source.folder ? folderIdentity(this.idx, source.folder) : undefined, destination.folder, [...source.issues, ...destination.issues]);
      return;
    }
    if (selection.kind === 'folder') this.placeFolder(source.folder, destination.folder, 'operator-selection');
    else this.consolidate(source.folder, destination.folder, 'operator-selection');
  }
}

const isSelector = (value: unknown): value is FolderSelector =>
  isRecord(value) && typeof value.path === 'string' && value.path !== '' && (value.ref === undefined || typeof value.ref === 'string');

function isValidSelection(value: unknown): value is MovementSelection {
  if (!isRecord(value) || !isSelector(value.destination)) return false;
  if (value.kind === 'file') return isSelector(value.parent) && typeof value.name === 'string' && value.name !== '';
  return (value.kind === 'folder' || value.kind === 'folder-contents') && isSelector(value.source);
}

/**
 * Primeira etapa: uma proposta por operação derivada das seleções, com os impedimentos locais. O
 * pedido é posto em ordem canônica: a ordem das seleções não muda o resultado. Tudo fica em
 * 'generated' até `assessMovementProposals`.
 */
export function generateMovementProposals(inv: TreeInventoryExport, request: MovementRequest, inventoryId: string): MovementProposal[] {
  const builder = new ProposalBuilder(inv, inventoryId);
  const canonical = new Map<string, MovementSelection>();
  for (const selection of request.selections) {
    const clean = JSON.parse(JSON.stringify(selection ?? null)) as MovementSelection;
    canonical.set(canonicalJson(clean), clean);
  }
  for (const key of [...canonical.keys()].sort(compareText)) builder.select(canonical.get(key)!);
  return [...builder.proposals.values()];
}

/* ───────────── Avaliação entre operações ───────────── */

const copyProposal = (p: MovementProposal): MovementProposal => ({ ...p, alerts: [...p.alerts], dependsOn: [...p.dependsOn], conflicts: [...p.conflicts], blockers: [...p.blockers] });

function groupBy<T>(values: T[], keyOf: (value: T) => string | undefined): T[][] {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    if (key !== undefined) groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return [...groups.values()];
}

/** Choques entre propostas: a mesma origem pedida duas vezes, ou dois itens com o mesmo nome no mesmo destino. */
function markCollisions(proposals: MovementProposal[]): void {
  for (const group of groupBy(proposals, (p) => (p.source ? sourceKey(p.source) : undefined))) {
    if (group.length < 2) continue;
    for (const p of group) {
      p.conflicts.push({ code: 'source-claimed-twice', message: 'A mesma origem aparece em mais de uma operação: exige escolher uma.', relatedOperations: group.filter((o) => o !== p).map((o) => o.id).sort(compareText) });
    }
  }
  const arriving = proposals.filter((p) => p.kind !== 'consolidate-folder' && p.destination && p.source?.name !== undefined);
  for (const group of groupBy(arriving, (p) => `${p.destination!.folder.ref}\u0000${normalizeName(p.source!.name!)}`)) {
    if (group.length < 2) continue;
    for (const p of group) {
      p.conflicts.push({ code: 'destination-collision', message: 'Mais de uma operação levaria itens com nomes iguais ou equivalentes ao mesmo destino: exige decisão humana.', refs: [p.destination!.folder.ref], relatedOperations: group.filter((o) => o !== p).map((o) => o.id).sort(compareText) });
    }
  }
}

/**
 * Dependências. Consolidação antes de suas operações. E, quando uma pasta inteira é movida, tudo o
 * que retira algo de dentro dela ou leva algo para dentro dela vem ANTES: as identidades e os
 * caminhos conferidos são os do inventário.
 */
function addDependencies(idx: InventoryIndex, proposals: MovementProposal[]): void {
  const movingFrom = new Map<string, MovementProposal[]>();
  for (const p of proposals) {
    if (p.kind === 'move-folder' && p.source?.kind === 'folder') movingFrom.set(p.source.ref, [...(movingFrom.get(p.source.ref) ?? []), p]);
  }
  const before = (op: MovementProposal, ref: string | undefined) => {
    for (const ancestor of lineage(idx, ref)) {
      for (const mover of movingFrom.get(ancestor.ref) ?? []) if (mover !== op && !mover.dependsOn.includes(op.id)) mover.dependsOn.push(op.id);
    }
  };
  for (const p of proposals) {
    if (p.parentOperation && !p.dependsOn.includes(p.parentOperation)) p.dependsOn.push(p.parentOperation);
    if (p.source) before(p, p.source.parentRef);
    if (p.destination) before(p, p.destination.folder.ref);
  }
  for (const p of proposals) p.dependsOn.sort(compareText);
}

const orderKey = (p: MovementProposal) => `${p.source?.path ?? '￿'}\u0000${p.destination?.folder.path ?? ''}\u0000${p.id}`;

/** Kahn com desempate estável. O que sobra depende de um ciclo ou faz parte dele. */
function topologicalOrder(proposals: MovementProposal[]): { ordered: MovementProposal[]; remaining: MovementProposal[] } {
  const byId = new Map(proposals.map((p) => [p.id, p]));
  const missing = new Map(proposals.map((p) => [p.id, p.dependsOn.filter((d) => byId.has(d)).length]));
  const dependents = new Map<string, MovementProposal[]>();
  for (const p of proposals) for (const d of p.dependsOn) dependents.set(d, [...(dependents.get(d) ?? []), p]);
  const key = new Map(proposals.map((p) => [p.id, orderKey(p)]));
  const insert = (ready: MovementProposal[], p: MovementProposal) => {
    let low = 0;
    let high = ready.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (key.get(ready[mid]!.id)! < key.get(p.id)!) low = mid + 1;
      else high = mid;
    }
    ready.splice(low, 0, p);
  };
  const ready: MovementProposal[] = [];
  for (const p of proposals) if (missing.get(p.id) === 0) insert(ready, p);
  const ordered: MovementProposal[] = [];
  while (ready.length) {
    const next = ready.shift()!;
    ordered.push(next);
    for (const d of dependents.get(next.id) ?? []) {
      const left = missing.get(d.id)! - 1;
      missing.set(d.id, left);
      if (left === 0) insert(ready, d);
    }
  }
  const done = new Set(ordered.map((p) => p.id));
  return { ordered, remaining: proposals.filter((p) => !done.has(p.id)).sort((a, b) => compareText(key.get(a.id)!, key.get(b.id)!)) };
}

/** Do que sobrou de Kahn, só quem está de fato num ciclo (ou entre ciclos): retira quem apenas depende deles. */
function cycleMembers(remaining: MovementProposal[]): MovementProposal[] {
  let members = remaining;
  for (;;) {
    const ids = new Set(members.map((p) => p.id));
    const needed = new Set(members.flatMap((p) => p.dependsOn.filter((d) => ids.has(d))));
    const next = members.filter((p) => needed.has(p.id));
    if (next.length === members.length) return members;
    members = next;
  }
}

const isBlocked = (p: MovementProposal) => p.conflicts.length > 0 || p.blockers.length > 0;

/**
 * Segunda etapa: colisões, dependências, ciclos e propagação de bloqueios. Decide o estado final de
 * cada proposta, sem alterar a entrada. `safeOrder` só tem propostas aptas para revisão.
 */
export function assessMovementProposals(inv: TreeInventoryExport, generated: MovementProposal[]): { proposals: MovementProposal[]; safeOrder: string[] } {
  const idx = indexInventory(inv);
  const proposals = generated.map(copyProposal);
  markCollisions(proposals);
  addDependencies(idx, proposals);

  if (inv.environment.sector.status !== 'identified') {
    for (const p of proposals) p.blockers.push({ code: 'sector-not-identified', message: 'Setor não identificado na leitura: nenhuma operação pode ser considerada.' });
  }

  const { ordered, remaining } = topologicalOrder(proposals);
  const inCycle = cycleMembers(remaining);
  for (const p of inCycle) {
    p.blockers.push({ code: 'dependency-cycle', message: 'As dependências desta operação formam um ciclo: não há ordem segura.', relatedOperations: inCycle.filter((o) => o !== p).map((o) => o.id).sort(compareText) });
  }

  const all = [...ordered, ...remaining];
  const byId = new Map(all.map((p) => [p.id, p]));
  const childrenOf = new Map<string, MovementProposal[]>();
  for (const p of all) if (p.parentOperation) childrenOf.set(p.parentOperation, [...(childrenOf.get(p.parentOperation) ?? []), p]);
  const descendants = (p: MovementProposal): MovementProposal[] => (childrenOf.get(p.id) ?? []).flatMap((c) => [c, ...descendants(c)]);
  /** Aptas de fato: uma consolidação interna não tem efeito próprio, só suas operações. */
  const hasReadyWork = (below: MovementProposal[]) => below.some((d) => d.kind !== 'consolidate-folder' && !isBlocked(d));

  // Até estabilizar: bloqueio passa a quem depende, e consolidação sem nenhuma operação apta fica bloqueada.
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of all) {
      if (p.blockers.some((b) => b.code === 'dependency-blocked' || b.code === 'dependency-cycle')) continue;
      const blockedBy = p.dependsOn.filter((d) => byId.has(d) && isBlocked(byId.get(d)!));
      if (blockedBy.length) {
        p.blockers.push({ code: 'dependency-blocked', message: 'Depende de operação bloqueada.', relatedOperations: blockedBy });
        changed = true;
      }
    }
    for (const p of all) {
      if (p.kind !== 'consolidate-folder' || isBlocked(p)) continue;
      const below = descendants(p);
      if (below.some(isBlocked) && !hasReadyWork(below)) {
        p.blockers.push({ code: 'no-ready-operations', message: 'Nenhuma operação desta consolidação está apta para revisão.' });
        changed = true;
      }
    }
  }

  for (const p of all) {
    p.state = isBlocked(p) ? 'blocked' : 'ready-for-review';
    if (p.kind !== 'consolidate-folder') continue;
    const below = descendants(p);
    const blocked = below.filter(isBlocked);
    const status: ConsolidationStatus = isBlocked(p) ? 'fully-blocked' : hasReadyWork(below) ? (blocked.length ? 'partially-blocked' : 'all-ready') : 'empty';
    p.group = {
      status,
      authorizesOperations: false,
      readyOperations: below.filter((d) => !isBlocked(d)).map((d) => d.id).sort(compareText),
      blockedOperations: blocked.map((d) => d.id).sort(compareText),
    };
    if (blocked.length) p.alerts.push(`${plural(blocked.length, 'operação desta consolidação está bloqueada', 'operações desta consolidação estão bloqueadas')}: os itens envolvidos permanecem na origem, e a consolidação não as libera.`);
    if (status === 'empty') p.alerts.push('A pasta de origem não tem o que consolidar.');
  }
  return { proposals: all, safeOrder: ordered.filter((p) => p.state === 'ready-for-review').map((p) => p.id) };
}

/* ───────────── Plano ───────────── */

function involvedItems(idx: InventoryIndex, proposals: MovementProposal[]): number {
  const involved = new Set<string>();
  const addFolder = (root: FolderNode) => {
    const row = idx.row.get(root.ref);
    if (row && root.parentRef) involved.add(observation(root.parentRef, row));
    for (const f of subtreeOf(idx, root)) for (const item of f.items) involved.add(observation(f.ref, item));
  };
  for (const p of proposals) {
    if (p.source?.kind === 'file' && p.source.observationKey) involved.add(`${p.source.parentRef}\u0000${p.source.observationKey}`);
    else if (p.kind === 'move-folder' && p.source?.kind === 'folder') {
      const folder = idx.folders.get(p.source.ref);
      if (folder) addFolder(folder);
    }
  }
  return involved.size;
}

/**
 * Gera o plano. A elegibilidade é exatamente a do planejamento de organização (ADR-016). Um
 * inventário recusado não produz propostas: nenhuma seleção é avaliada sobre dados não comprovados.
 */
export function planMovements(input: unknown, request: MovementRequest, options: PlanOptions): MovementPlan {
  if (!isRecord(request) || !Array.isArray(request.selections)) throw new TypeError('O pedido precisa ter a lista de seleções.');
  const basis = planOrganization(input, options);
  const accepted = basis.validation.status === 'accepted' && basis.source.inventoryId !== undefined;
  const base = {
    kind: MOVEMENT_PLAN_FORMAT as typeof MOVEMENT_PLAN_FORMAT,
    schemaVersion: 1 as const,
    plannerVersion: MOVEMENT_PLANNER_VERSION,
    engineVersion: ENGINE_VERSION,
    identifiable: accepted,
    generatedAt: options.now.toISOString(),
    dryRun: true as const,
    executable: false as const,
    authorizesChanges: false as const,
    authenticated: false as const,
    notices: MOVEMENT_NOTICES,
    source: basis.source,
    validation: basis.validation,
  };
  const byState: Record<MovementState, number> = { generated: 0, blocked: 0, 'ready-for-review': 0 };
  const byKind: Record<MovementKind, number> = { 'move-file': 0, 'move-folder': 0, 'consolidate-folder': 0 };
  const consolidations: Record<ConsolidationStatus, number> = { 'all-ready': 0, 'partially-blocked': 0, 'fully-blocked': 0, empty: 0 };
  if (!accepted) {
    return { ...base, summary: { selections: request.selections.length, proposals: 0, byState, byKind, consolidations, conflicts: 0, blockers: 0, items: { inventory: 0, involved: 0, notInvolved: 0 } }, safeOrder: [], proposals: [] };
  }

  const inv = input as TreeInventoryExport;
  const { proposals, safeOrder } = assessMovementProposals(inv, generateMovementProposals(inv, request, basis.source.inventoryId!));
  for (const p of proposals) {
    byState[p.state]++;
    byKind[p.kind]++;
    if (p.group) consolidations[p.group.status]++;
  }
  const inventory = inv.folders.reduce((sum, f) => sum + f.items.length, 0);
  const involved = involvedItems(indexInventory(inv), proposals);
  return {
    ...base,
    summary: {
      selections: request.selections.length,
      proposals: proposals.length,
      byState,
      byKind,
      consolidations,
      conflicts: proposals.reduce((sum, p) => sum + p.conflicts.length, 0),
      blockers: proposals.reduce((sum, p) => sum + p.blockers.length, 0),
      items: { inventory, involved, notInvolved: inventory - involved },
    },
    safeOrder,
    proposals,
  };
}

/** Versão sem dados identificáveis: sem nomes, caminhos, seleções, assinaturas nem `runId`. */
export function redactMovementPlan(plan: MovementPlan): MovementPlan {
  const { runId: _r, checkpointRunId: _c, ...source } = plan.source;
  const redactIdentity = <T extends FolderIdentity | FileIdentity>(identity: T): T => {
    const { name: _n, path: _p, ...rest } = identity;
    if (rest.kind === 'file') {
      const { observationKey: _o, ...file } = rest as Omit<FileIdentity, 'name' | 'path'>;
      return file as T;
    }
    return rest as T;
  };
  return {
    ...plan,
    identifiable: false,
    source,
    proposals: plan.proposals.map(({ requested: _requested, source: from, destination, ...p }) => ({
      ...p,
      ...(from ? { source: redactIdentity(from) } : {}),
      ...(destination ? { destination: { folder: redactIdentity(destination.folder) } } : {}),
    })),
  };
}
