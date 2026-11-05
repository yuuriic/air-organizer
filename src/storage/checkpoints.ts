import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ResumeRejectedError,
  compareCheckpointScope,
  idsFor,
  sealCheckpoint,
  validateCheckpoint,
  type CheckpointScope,
  type CheckpointState,
  type Pseudonymize,
  type ResumeRejection,
  type TreeCheckpoint,
} from '../core/checkpoint.js';
import type { TreeCheckpointSnapshot } from '../core/tree-scanner.js';
import type { InventoryAuthenticator } from '../core/inventory-integrity.js';
import { SafetyViolation, assertInsideDirectory, assertOutsideRepository } from '../safety/scope-validator.js';
import type { AirEnvironment, ResumeMode, TreeLimits } from '../types/inventory.js';
import { inventoryAuthenticator } from './integrity-key.js';

/**
 * Checkpoints da leitura recursiva em arquivos JSON locais (sem banco de dados).
 *
 * Proteção local:
 * - diretório no perfil do usuário (%LOCALAPPDATA%\air-organizer\checkpoints), fora do repositório;
 * - conteúdo pseudonimizado com HMAC-SHA256; a chave fica em outro arquivo do perfil
 *   (checkpoint.key): o checkpoint sozinho não permite confirmar nomes por tentativa;
 * - integridade por HMAC do documento, escrita atômica (temporário + rename), trava por execução;
 * - retenção: fora do prazo, o checkpoint não é retomado e pode ser excluído (com confirmação na CLI).
 *
 * Organização: <dir>/<instância>/<setor>/<pasta inicial>/<execução>/checkpoint.json, com
 * pseudônimos nos três primeiros níveis.
 */

export const DEFAULT_RETENTION_DAYS = 7;
const FILE = 'checkpoint.json';
const LOCK = 'checkpoint.lock';
const NO_SECTOR = 'setor-nao-informado';

export type CheckpointLocations = { dir: string; keyFile: string };

export function defaultCheckpointLocations(env: Record<string, string | undefined> = process.env): CheckpointLocations {
  const base = path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'air-organizer');
  return { dir: env.AIR_ORGANIZER_CHECKPOINT_DIR?.trim() || path.join(base, 'checkpoints'), keyFile: path.join(base, 'checkpoint.key') };
}

export type CheckpointEntry = { runDir: string; runId: string; checkpoint?: TreeCheckpoint; rejection?: ResumeRejection };

export type StoreOptions = CheckpointLocations & {
  retentionDays: number;
  now?: () => Date;
  /** Diretório que o checkpoint não pode ocupar (o repositório). Padrão: diretório atual. */
  repositoryDir?: string;
};

export async function writeAtomic(target: string, text: string): Promise<void> {
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, text, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  // No Windows, antivírus/indexador podem segurar o arquivo por instantes.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await unlink(temp).catch(() => {});
        throw error;
      }
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function loadKey(keyFile: string): Promise<Buffer> {
  try {
    const hex = (await readFile(keyFile, 'utf-8')).trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new SafetyViolation('Chave local de checkpoint inválida; mova-a para outro lugar para gerar uma nova.');
    return Buffer.from(hex, 'hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    try {
      await writeFile(keyFile, key.toString('hex'), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      return key;
    } catch (writeError) {
      // Outro processo criou a chave ao mesmo tempo: usa a dele.
      if ((writeError as NodeJS.ErrnoException).code === 'EEXIST') return loadKey(keyFile);
      throw writeError;
    }
  }
}

export class CheckpointStore {
  readonly pseudonymize: Pseudonymize;
  /**
   * Selo dos inventários desta execução (§8.5): subchave HKDF da MESMA chave carregada em `open`.
   * A exportação nunca relê nem recria a chave do disco; a chave em si não é exposta.
   */
  readonly inventoryAuthenticator: InventoryAuthenticator;
  private readonly retentionMs: number;
  private readonly now: () => Date;

  private constructor(readonly dir: string, key: Buffer, options: StoreOptions) {
    this.pseudonymize = (value) => createHmac('sha256', key).update(value, 'utf8').digest('hex').slice(0, 32);
    this.inventoryAuthenticator = inventoryAuthenticator(key);
    this.retentionMs = options.retentionDays * 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  static async open(options: StoreOptions): Promise<CheckpointStore> {
    if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) throw new Error('Retenção de checkpoints inválida (dias > 0).');
    const dir = path.resolve(options.dir);
    assertOutsideRepository([dir, options.keyFile], options.repositoryDir);
    return new CheckpointStore(dir, await loadKey(options.keyFile), options);
  }

  /** Escopo pseudonimizado do ambiente exibido; undefined se origem ou URL não foram identificadas. */
  scopeOf(env: AirEnvironment): CheckpointScope | undefined {
    if (env.instanceOrigin.status !== 'identified' || env.pageUrl.status !== 'identified') return undefined;
    const ids = idsFor(this.pseudonymize);
    return {
      instanceId: ids.instance(env.instanceOrigin.value),
      ...(env.client.status === 'identified' ? { clientId: ids.client(env.client.value) } : {}),
      ...(env.sector.status === 'identified' ? { sectorId: ids.sector(env.sector.value) } : {}),
      startKeyId: ids.key(env.pageUrl.value),
    };
  }

  private runDirFor(scope: CheckpointScope, runId: string): string {
    if (!/^[a-z0-9-]+$/i.test(runId)) throw new SafetyViolation('Identificador de execução inválido.');
    const seg = (id: string) => id.slice(0, 16);
    return assertInsideDirectory(this.dir, path.join(seg(scope.instanceId), scope.sectorId ? seg(scope.sectorId) : NO_SECTOR, seg(scope.startKeyId), runId));
  }

  /** Nova execução: cria o diretório e trava-o para esta sessão. */
  async create(scope: CheckpointScope, runId: string, limits: TreeLimits): Promise<CheckpointSession> {
    const runDir = this.runDirFor(scope, runId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await acquireLock(runDir);
    const at = this.now().toISOString();
    return new CheckpointSession(this, runDir, {
      runId,
      createdAt: at,
      scope,
      sessions: [{ startedAt: at, limits, resumed: false, outcome: 'running' }],
    });
  }

  /**
   * Retomada: revalida o arquivo (pode ter mudado desde a listagem), confere o escopo com o
   * ambiente exibido e trava a execução. Qualquer dúvida = ResumeRejectedError, sem cliques.
   */
  async resume(entry: CheckpointEntry, current: CheckpointScope, limits: TreeLimits, mode: ResumeMode): Promise<{ session: CheckpointSession; checkpoint: TreeCheckpoint }> {
    const runDir = assertInsideDirectory(this.dir, path.relative(this.dir, entry.runDir));
    await acquireLock(runDir);
    try {
      const loaded = await this.read(runDir);
      if ('rejection' in loaded) throw new ResumeRejectedError(loaded.rejection);
      const mismatch = compareCheckpointScope(loaded.checkpoint.scope, current);
      if (mismatch) throw new ResumeRejectedError(mismatch);
      const cp = loaded.checkpoint;
      const session = new CheckpointSession(this, runDir, {
        runId: cp.runId,
        createdAt: cp.createdAt,
        scope: cp.scope,
        // Uma sessão anterior que não chegou ao fim fica registrada como interrompida.
        sessions: [
          ...cp.sessions.map((s) => (s.outcome === 'running' ? { ...s, outcome: 'failed' as const } : s)),
          { startedAt: this.now().toISOString(), limits, resumed: true, mode, outcome: 'running' },
        ],
      });
      return { session, checkpoint: cp };
    } catch (error) {
      await releaseLock(runDir);
      throw error;
    }
  }

  private async read(runDir: string): Promise<{ checkpoint: TreeCheckpoint } | { rejection: ResumeRejection }> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path.join(runDir, FILE), 'utf-8'));
    } catch {
      return { rejection: { code: 'unreadable', message: 'Checkpoint ilegível (arquivo ausente, truncado ou JSON inválido).' } };
    }
    return validateCheckpoint(raw, { pseudonymize: this.pseudonymize, now: this.now(), retentionMs: this.retentionMs });
  }

  /** Todas as execuções gravadas, com o motivo de recusa quando não podem ser retomadas. */
  async list(): Promise<CheckpointEntry[]> {
    const entries: CheckpointEntry[] = [];
    const dirs = async (p: string) => (await readdir(p, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
    for (const a of await dirs(this.dir)) {
      for (const b of await dirs(a)) {
        for (const c of await dirs(b)) {
          for (const runDir of await dirs(c)) {
            const loaded = await this.read(runDir);
            const runId = path.basename(runDir);
            if ('rejection' in loaded) {
              entries.push({ runDir, runId, rejection: loaded.rejection });
            } else if (await lockedByOther(runDir)) {
              entries.push({ runDir, runId, checkpoint: loaded.checkpoint, rejection: { code: 'locked', message: 'Execução em uso por outro processo do AIR Organizer.' } });
            } else {
              entries.push({ runDir, runId, checkpoint: loaded.checkpoint });
            }
          }
        }
      }
    }
    return entries.sort((x, y) => (y.checkpoint?.updatedAt ?? '').localeCompare(x.checkpoint?.updatedAt ?? ''));
  }

  /** Exclui só execuções fora do prazo de retenção. Devolve quantas foram excluídas. */
  async purgeExpired(): Promise<number> {
    let removed = 0;
    for (const entry of await this.list()) {
      if (entry.rejection?.code !== 'expired') continue;
      await rm(assertInsideDirectory(this.dir, path.relative(this.dir, entry.runDir)), { recursive: true, force: true });
      removed++;
    }
    return removed;
  }

  /** @internal */
  nowIso(): string {
    return this.now().toISOString();
  }
}

type SessionBase = Pick<TreeCheckpoint, 'runId' | 'createdAt' | 'scope' | 'sessions'>;

/** Sessão de escrita de um checkpoint (dona da trava). */
export class CheckpointSession {
  private released = false;

  constructor(
    private readonly store: CheckpointStore,
    readonly runDir: string,
    private base: SessionBase,
  ) {}

  get runId(): string {
    return this.base.runId;
  }

  async save(snapshot: TreeCheckpointSnapshot): Promise<void> {
    if (this.released) throw new Error('Sessão de checkpoint encerrada.');
    const at = this.store.nowIso();
    const state: CheckpointState = snapshot.final ? snapshot.final.status : 'running';
    const sessions = this.base.sessions.map((s, i, all) => (i === all.length - 1 ? { ...s, outcome: state, ...(snapshot.final ? { endedAt: at } : {}) } : s));
    this.base = { ...this.base, sessions };
    const current = sessions[sessions.length - 1]!;
    const checkpoint = sealCheckpoint(
      {
        kind: 'air-organizer/tree-checkpoint',
        schemaVersion: 1,
        runId: this.base.runId,
        createdAt: this.base.createdAt,
        updatedAt: at,
        state,
        scope: this.base.scope,
        limits: current.limits,
        limitsReached: snapshot.limitsReached,
        totals: snapshot.totals,
        sessions,
        folders: snapshot.folders,
      },
      this.store.pseudonymize,
    );
    await writeAtomic(path.join(this.runDir, FILE), JSON.stringify(checkpoint));
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await releaseLock(this.runDir);
  }
}

async function acquireLock(runDir: string): Promise<void> {
  const file = path.join(runDir, LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await lockedByOther(runDir)) {
        throw new ResumeRejectedError({ code: 'locked', message: 'Execução em uso por outro processo do AIR Organizer.' });
      }
      await unlink(file).catch(() => {}); // trava órfã (processo encerrado)
    }
  }
  throw new ResumeRejectedError({ code: 'locked', message: 'Não foi possível travar a execução para escrita.' });
}

/** Trava existente de um processo vivo (inclusive este: uma sessão por execução). */
async function lockedByOther(runDir: string): Promise<boolean> {
  try {
    const { pid } = JSON.parse(await readFile(path.join(runDir, LOCK), 'utf-8')) as { pid?: unknown };
    return typeof pid === 'number' && processAlive(pid);
  } catch {
    return false;
  }
}

async function releaseLock(runDir: string): Promise<void> {
  await unlink(path.join(runDir, LOCK)).catch(() => {});
}
