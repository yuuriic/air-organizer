import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResumeRejectedError } from '../../src/core/checkpoint.js';
import { scanTree } from '../../src/core/tree-scanner.js';
import { SafetyViolation } from '../../src/safety/scope-validator.js';
import { CheckpointStore, type CheckpointSession } from '../../src/storage/checkpoints.js';
import type { AirEnvironment, TreeLimits } from '../../src/types/inventory.js';
import { SimNavigator, file, folder } from '../sim-navigator.js';

const LIMITS: TreeLimits = { maxDepth: 5, maxFolders: 50, maxItems: 1_000, maxPagesPerFolder: 10 };
const SECRET = ['BELTRANA DE TAL', 'REGISTRO 111.222.333-44', 'CICRANO REG 00000'];
const tree = () => folder('root', SECRET[0]!, [folder('p', SECRET[1]!, [file('x', `${SECRET[2]}.pdf`)]), folder('q', 'Q')]);

function env(overrides: Partial<AirEnvironment> = {}): AirEnvironment {
  return {
    instanceOrigin: { status: 'identified', value: 'https://air.exemplo.test', source: 'url' },
    pageUrl: { status: 'identified', value: 'https://air.exemplo.test/air/my-air/root', source: 'url' },
    client: { status: 'identified', value: 'Cliente Ficticio', source: 'operator' },
    sector: { status: 'identified', value: 'Setor Ficticio', source: 'operator' },
    currentFolder: { status: 'identified', value: SECRET[0]!, source: 'page-heading' },
    breadcrumb: { status: 'not-identified', reason: 'x' },
    observedAt: '2026-11-03T00:00:00.000Z',
    ...overrides,
  };
}

let base: string;
let clock: Date;
const open = (retentionDays = 7) =>
  CheckpointStore.open({ dir: path.join(base, 'checkpoints'), keyFile: path.join(base, 'checkpoint.key'), retentionDays, now: () => clock });

/** Executa a leitura simulada gravando no store; `lose` interrompe para deixar pendências. */
async function runInto(session: CheckpointSession, store: CheckpointStore, lose: string[] = ['q']) {
  try {
    return await scanTree(new SimNavigator(tree(), { lose }), LIMITS, { checkpoint: { pseudonymize: store.pseudonymize, save: (s) => session.save(s) } });
  } finally {
    await session.release();
  }
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-cp-'));
  clock = new Date('2026-11-03T12:00:00.000Z');
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('CheckpointStore', () => {
  it('recusa diretório ou chave dentro do repositório', async () => {
    await expect(CheckpointStore.open({ dir: path.join(process.cwd(), 'checkpoints'), keyFile: path.join(base, 'k'), retentionDays: 7 })).rejects.toThrow(SafetyViolation);
    await expect(CheckpointStore.open({ dir: path.join(base, 'c'), keyFile: path.join(process.cwd(), 'k'), retentionDays: 7 })).rejects.toThrow(SafetyViolation);
  });

  it('grava atomicamente, pseudonimizado, sem temporários; diretórios sem domínio nem setor', async () => {
    const store = await open();
    const scope = store.scopeOf(env())!;
    const session = await store.create(scope, 'run-1', LIMITS);
    await runInto(session, store);

    const text = await readFile(path.join(session.runDir, 'checkpoint.json'), 'utf-8');
    for (const s of [...SECRET, 'exemplo.test', 'my-air', 'Cliente Ficticio', 'Setor Ficticio', '.pdf']) expect(text).not.toContain(s);
    expect(JSON.parse(text)).toMatchObject({ kind: 'air-organizer/tree-checkpoint', state: 'failed', runId: 'run-1' });
    expect((await readdir(session.runDir)).sort()).toEqual(['checkpoint.json']); // sem .tmp, trava liberada
    const rel = path.relative(base, session.runDir);
    expect(rel).not.toMatch(/exemplo|setor|cliente/i);
    expect(rel.split(path.sep)).toHaveLength(5); // checkpoints/<instância>/<setor>/<pasta inicial>/<execução>
  });

  it('lista como válida, retoma revalidando o escopo e registra a sessão anterior como interrompida', async () => {
    const store = await open();
    const scope = store.scopeOf(env())!;
    await runInto(await store.create(scope, 'run-1', LIMITS), store);

    const [entry] = await store.list();
    expect(entry).toMatchObject({ runId: 'run-1' });
    expect(entry!.rejection).toBeUndefined();

    const { session, checkpoint } = await store.resume(entry!, scope, LIMITS, 'fast');
    expect(checkpoint.folders.length).toBeGreaterThan(0);
    const result = await scanTree(new SimNavigator(tree()), LIMITS, {
      checkpoint: { pseudonymize: store.pseudonymize, save: (s) => session.save(s), resume: { from: checkpoint.folders, mode: 'fast' } },
    });
    await session.release();
    expect(result.status).toBe('complete');
    const saved = JSON.parse(await readFile(path.join(session.runDir, 'checkpoint.json'), 'utf-8'));
    expect(saved.sessions.map((s: { resumed: boolean; outcome: string }) => [s.resumed, s.outcome])).toEqual([
      [false, 'failed'],
      [true, 'complete'],
    ]);
    expect((await store.list())[0]!.rejection?.code).toBe('finished');
  });

  it('recusa escopo diferente sem deixar a execução travada', async () => {
    const store = await open();
    const scope = store.scopeOf(env())!;
    await runInto(await store.create(scope, 'run-1', LIMITS), store);
    const [entry] = await store.list();
    for (const [changed, code] of [
      [env({ sector: { status: 'identified', value: 'Outro Setor', source: 'operator' } }), 'sector-mismatch'],
      [env({ instanceOrigin: { status: 'identified', value: 'https://outra.exemplo.test', source: 'url' } }), 'instance-mismatch'],
      [env({ pageUrl: { status: 'identified', value: 'https://air.exemplo.test/air/my-air/outra', source: 'url' } }), 'start-folder-mismatch'],
    ] as const) {
      await expect(store.resume(entry!, store.scopeOf(changed)!, LIMITS, 'fast')).rejects.toMatchObject({ rejection: { code } });
    }
    const { session } = await store.resume(entry!, scope, LIMITS, 'fast'); // não ficou travada
    await session.release();
  });

  it('uma sessão por execução: trava viva recusa; trava órfã é substituída', async () => {
    const store = await open();
    const scope = store.scopeOf(env())!;
    await runInto(await store.create(scope, 'run-1', LIMITS), store);
    const [entry] = await store.list();

    const { session } = await store.resume(entry!, scope, LIMITS, 'fast');
    expect((await store.list())[0]!.rejection?.code).toBe('locked');
    await expect(store.resume(entry!, scope, LIMITS, 'fast')).rejects.toThrow(ResumeRejectedError);
    await session.release();

    const dead = spawnSync(process.execPath, ['-e', '']).pid!; // processo já encerrado
    await writeFile(path.join(entry!.runDir, 'checkpoint.lock'), JSON.stringify({ pid: dead }));
    const again = await store.resume(entry!, scope, LIMITS, 'fast');
    await again.session.release();
  });

  it('arquivo alterado, truncado ou de outra chave local é recusado', async () => {
    const store = await open();
    const scope = store.scopeOf(env())!;
    const session = await store.create(scope, 'run-1', LIMITS);
    await runInto(session, store);
    const file = path.join(session.runDir, 'checkpoint.json');
    const original = await readFile(file, 'utf-8');

    await writeFile(file, original.replace('"state":"failed"', '"state":"partial"'));
    expect((await store.list())[0]!.rejection?.code).toBe('integrity');
    await writeFile(file, original.slice(0, original.length / 2));
    expect((await store.list())[0]!.rejection?.code).toBe('unreadable');

    await writeFile(file, original);
    await rm(path.join(base, 'checkpoint.key'));
    expect((await (await open()).list())[0]!.rejection?.code).toBe('integrity'); // nova chave
  });

  it('retenção: fora do prazo não é retomado; a limpeza exclui só os expirados', async () => {
    const store = await open(7);
    const scope = store.scopeOf(env())!;
    await runInto(await store.create(scope, 'run-old', LIMITS), store);
    clock = new Date('2026-11-12T12:00:00.000Z');
    await runInto(await store.create(scope, 'run-new', LIMITS), store);

    const entries = await store.list();
    expect(Object.fromEntries(entries.map((e) => [e.runId, e.rejection?.code ?? 'ok']))).toEqual({ 'run-old': 'expired', 'run-new': 'ok' });
    expect(await store.purgeExpired()).toBe(1);
    expect((await store.list()).map((e) => e.runId)).toEqual(['run-new']);
  });

  it('registra o modo de cada retomada nas sessões do checkpoint', async () => {
    const store = await open();
    const scope = store.scopeOf(env())!;
    await runInto(await store.create(scope, 'run-1', LIMITS), store);
    const { session, checkpoint } = await store.resume((await store.list())[0]!, scope, LIMITS, 'verified');
    await scanTree(new SimNavigator(tree()), LIMITS, {
      checkpoint: { pseudonymize: store.pseudonymize, save: (s) => session.save(s), resume: { from: checkpoint.folders, mode: 'verified' } },
    });
    await session.release();
    const saved = JSON.parse(await readFile(path.join(session.runDir, 'checkpoint.json'), 'utf-8'));
    expect(saved.sessions.map((s: { mode?: string }) => s.mode ?? 'nova')).toEqual(['nova', 'verified']);
  });

  it('sem origem ou URL identificadas não há escopo (nem checkpoint)', async () => {
    const store = await open();
    expect(store.scopeOf(env({ pageUrl: { status: 'not-identified', reason: 'x' } }))).toBeUndefined();
  });
});
