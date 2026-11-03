import type { FolderStatus, PendingReason, ResumeMode, ScanIssueKind, TreeLimits, TreeResult, TreeTotals } from '../types/inventory.js';

/**
 * Checkpoint da leitura recursiva (POC-01E). Modelo puro, sem sistema de arquivos.
 *
 * Minimização: o checkpoint não guarda nomes, caminhos, URLs, mensagens nem itens. Cada
 * identificador observado vira um pseudônimo HMAC (`Pseudonymize`, chave local fora do
 * repositório). Isso basta para RECONHECER na retomada a mesma pasta, a mesma linha e a mesma
 * página, mas não para navegar: por isso a unidade de reaproveitamento é a subárvore inteira,
 * nunca uma página (ARCHITECTURE.md §7.7).
 */

/** HMAC de um valor observado. Determinístico para a mesma chave local. */
export type Pseudonymize = (value: string) => string;

/** Pseudônimos com separação de domínio: o mesmo texto como nome e como caminho gera ids diferentes. */
export function idsFor(pseudonymize: Pseudonymize) {
  const id = (domain: string) => (value: string) => pseudonymize(`${domain}\u0000${value}`);
  return {
    instance: id('instance'),
    client: id('client'),
    sector: id('sector'),
    key: id('folder-key'),
    name: id('name'),
    path: id('path'),
    row: id('row'),
    page: id('page'),
    digest: id('digest'),
  };
}

export type CheckpointFolder = {
  /** Referência da execução no momento da gravação (F1 = pasta inicial). */
  ref: string;
  parentRef?: string;
  depth: number;
  nameId: string;
  /** Linha da pasta na listagem do pai (todos os metadados); ausente na pasta inicial. */
  rowId?: string;
  /** URL da pasta (sem query); só quando a pasta foi aberta. */
  keyId?: string;
  pathId?: string;
  /** Total do título "Nome (N)" quando aberta. */
  total?: number;
  /** Páginas lidas: número, assinatura pseudonimizada e linhas. */
  pages: Array<{ n: number; signatureId: string; rows: number }>;
  status: FolderStatus;
  subtreeStatus: FolderStatus;
  reasons: PendingReason[];
  refusal?: string;
  counts: { items: number; folders: number; files: number; unknown: number; locationMismatch: number; pagesRead: number; unreadPages: number[] };
  issueKinds: ScanIssueKind[];
  /** A decisão sobre esta pasta terminou nesta sessão (leitura e filhos, ou pendência registrada). */
  settled: boolean;
  observedAt: string;
};

export type CheckpointScope = {
  instanceId: string;
  clientId?: string;
  sectorId?: string;
  startKeyId: string;
};

export type CheckpointState = 'running' | TreeResult['status'];

export type TreeCheckpoint = {
  kind: 'air-organizer/tree-checkpoint';
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  /** 'running' sem trava ativa = execução interrompida (processo encerrado no meio). */
  state: CheckpointState;
  scope: CheckpointScope;
  limits: TreeLimits;
  limitsReached: TreeResult['limitsReached'];
  totals: TreeTotals;
  /** `mode`: ausente na sessão que iniciou a execução; o modo de cada retomada. */
  sessions: Array<{ startedAt: string; endedAt?: string; limits: TreeLimits; resumed: boolean; mode?: ResumeMode; outcome: CheckpointState }>;
  folders: CheckpointFolder[];
  /** HMAC do restante do documento: detecta arquivo truncado, editado ou de outra chave. */
  digest: string;
};

/**
 * Pendências que podem mudar numa nova tentativa (limites, falhas de leitura ou navegação).
 * As demais (homônimo, "Caminho" de outro ramo, tipo desconhecido, ciclo, visita repetida)
 * são propriedades do conteúdo: repetir a leitura daria o mesmo resultado.
 */
export const RETRYABLE_REASONS: ReadonlySet<PendingReason> = new Set<PendingReason>([
  'max-depth',
  'max-folders',
  'max-items',
  'max-pages',
  'read-incomplete',
  'read-error',
  'open-refused',
  'navigation-lost',
  'return-failed',
  'run-aborted',
  // Conteúdo divergente na volta: a subárvore nunca é reaproveitada sem ser relida.
  'content-changed',
]);

export function childrenByParent(folders: readonly CheckpointFolder[]): Map<string, CheckpointFolder[]> {
  const map = new Map<string, CheckpointFolder[]>();
  for (const f of folders) {
    if (!f.parentRef) continue;
    const list = map.get(f.parentRef) ?? [];
    list.push(f);
    map.set(f.parentRef, list);
  }
  return map;
}

/** Pasta e descendentes, na ordem gravada (DFS). */
export function subtreeOf(folders: readonly CheckpointFolder[], ref: string): CheckpointFolder[] {
  const children = childrenByParent(folders);
  const out: CheckpointFolder[] = [];
  const walk = (r: string) => {
    const f = folders.find((x) => x.ref === r);
    if (!f) return;
    out.push(f);
    for (const c of children.get(r) ?? []) walk(c.ref);
  };
  walk(ref);
  return out;
}

/**
 * Subárvore "assentada": a pasta foi lida e todas as decisões abaixo dela terminaram sem
 * pendência que valha repetir. Só uma subárvore assentada pode ser reaproveitada.
 */
export function isSettledSubtree(folders: readonly CheckpointFolder[], ref: string): boolean {
  const tree = subtreeOf(folders, ref);
  const [root] = tree;
  if (!root || (root.status !== 'complete' && root.status !== 'partial')) return false;
  return tree.every((f) => f.settled && !f.reasons.some((r) => RETRYABLE_REASONS.has(r)));
}

/** Há algo que uma nova sessão pode avançar? */
export function isResumable(folders: readonly CheckpointFolder[]): boolean {
  const root = folders.find((f) => !f.parentRef);
  return root !== undefined && !isSettledSubtree(folders, root.ref);
}

/** JSON com chaves ordenadas: a mesma informação gera sempre o mesmo texto. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function checkpointDigest(checkpoint: Omit<TreeCheckpoint, 'digest'>, pseudonymize: Pseudonymize): string {
  return idsFor(pseudonymize).digest(canonicalJson(checkpoint));
}

export function sealCheckpoint(checkpoint: Omit<TreeCheckpoint, 'digest'>, pseudonymize: Pseudonymize): TreeCheckpoint {
  return { ...checkpoint, digest: checkpointDigest(checkpoint, pseudonymize) };
}

/** Motivo de recusa da retomada. `code` e `message` não contêm nomes, caminhos nem URLs. */
export type ResumeRejection = {
  code:
    | 'unreadable'
    | 'schema'
    | 'integrity'
    | 'expired'
    | 'finished'
    | 'not-resumable'
    | 'locked'
    | 'instance-mismatch'
    | 'client-mismatch'
    | 'sector-mismatch'
    | 'start-folder-mismatch';
  message: string;
};

export class ResumeRejectedError extends Error {
  constructor(readonly rejection: ResumeRejection) {
    super(rejection.message);
    this.name = 'ResumeRejectedError';
  }
}

const reject = (code: ResumeRejection['code'], message: string): ResumeRejection => ({ code, message });

/**
 * Valida o checkpoint em si: formato, integridade (HMAC), retenção e se há o que retomar.
 * O escopo (instância, setor, pasta inicial) é verificado à parte, contra a página exibida.
 */
export function validateCheckpoint(
  raw: unknown,
  options: { pseudonymize: Pseudonymize; now: Date; retentionMs: number },
): { checkpoint: TreeCheckpoint } | { rejection: ResumeRejection } {
  const cp = raw as Partial<TreeCheckpoint> | null;
  if (!cp || typeof cp !== 'object' || cp.kind !== 'air-organizer/tree-checkpoint' || cp.schemaVersion !== 1) {
    return { rejection: reject('schema', 'Formato de checkpoint desconhecido ou de outra versão.') };
  }
  if (!Array.isArray(cp.folders) || !cp.scope || !cp.limits || typeof cp.digest !== 'string' || typeof cp.updatedAt !== 'string') {
    return { rejection: reject('schema', 'Checkpoint incompleto.') };
  }
  const { digest, ...body } = cp as TreeCheckpoint;
  if (checkpointDigest(body, options.pseudonymize) !== digest) {
    return { rejection: reject('integrity', 'Integridade não confirmada: arquivo alterado, truncado ou criado com outra chave local.') };
  }
  const checkpoint = cp as TreeCheckpoint;
  const age = options.now.getTime() - Date.parse(checkpoint.updatedAt);
  if (!Number.isFinite(age) || age > options.retentionMs) {
    return { rejection: reject('expired', 'Checkpoint fora do prazo de retenção; a estrutura pode ter mudado desde então.') };
  }
  if (checkpoint.state === 'complete') return { rejection: reject('finished', 'A execução já foi concluída; não há o que retomar.') };
  if (!isResumable(checkpoint.folders)) {
    return { rejection: reject('not-resumable', 'Não há pendência que uma nova tentativa possa resolver (só pendências do próprio conteúdo).') };
  }
  return { checkpoint };
}

/** Confere instância, cliente, setor e pasta inicial (pseudônimos) com o ambiente atual. */
export function compareCheckpointScope(saved: CheckpointScope, current: CheckpointScope): ResumeRejection | undefined {
  if (saved.instanceId !== current.instanceId) return reject('instance-mismatch', 'A instância AIR exibida não é a da execução gravada.');
  if (saved.clientId !== current.clientId) return reject('client-mismatch', 'O cliente informado não é o da execução gravada.');
  if (saved.sectorId !== current.sectorId) return reject('sector-mismatch', 'O setor informado não é o da execução gravada.');
  if (saved.startKeyId !== current.startKeyId) {
    return reject('start-folder-mismatch', 'A pasta exibida não é a pasta inicial da execução gravada. Navegue manualmente até ela.');
  }
  return undefined;
}
