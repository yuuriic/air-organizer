import type { Page } from 'playwright';
import { detectEnvironment, type OperatorContext } from '../air/navigator.js';
import { createAirTreeNavigator } from '../air/tree-navigator.js';
import { compareCheckpointScope, type CheckpointFolder, type CheckpointScope, type TreeCheckpoint } from '../core/checkpoint.js';
import { scanTree } from '../core/tree-scanner.js';
import type { CheckpointEntry, CheckpointSession, CheckpointStore } from '../storage/checkpoints.js';
import { DEFAULT_OUTPUT_DIR, exportTreeResult, newRunId, type TreeRunMeta } from '../storage/export.js';
import type { ResumeMode, TreeEvent, TreeLimits, TreeResult } from '../types/inventory.js';
import type { OperationalConfig } from './runtime.js';

/** Limites conservadores sugeridos para a primeira execução; o usuário confirma cada um. */
export const TREE_DEFAULTS: TreeLimits = { maxDepth: 1, maxFolders: 5, maxItems: 100, maxPagesPerFolder: 2 };

export type TreeRun = { result: TreeResult; limits: TreeLimits; meta: TreeRunMeta; checkpointFailures: number };

export type TreeRunInput = {
  page: Page;
  operator: OperatorContext;
  limits: TreeLimits;
  session: CheckpointSession;
  pseudonymize: (value: string) => string;
  resume?: { from: CheckpointFolder[]; mode: ResumeMode };
  config: OperationalConfig;
  signal?: AbortSignal;
  onEvent?: (event: TreeEvent) => void;
  /** Só na primeira falha de gravação do checkpoint. */
  onCheckpointFailure?: (errorName: string) => void;
};

/**
 * Executa a leitura recursiva gravando o checkpoint a cada passo. A trava do checkpoint é sempre
 * liberada. Usada pela nova análise e pela retomada, na CLI e no aplicativo.
 */
export async function runTreeScan(input: TreeRunInput): Promise<TreeRun> {
  const { page, operator, limits, session, config } = input;
  const startedAt = new Date().toISOString();
  const nav = createAirTreeNavigator(page, operator, { timeoutMs: config.pageTimeoutMs, pollMs: config.pollMs, readTimeoutMs: config.pageTimeoutMs });
  let checkpointFailures = 0;
  let result: TreeResult;
  let environment;
  try {
    environment = await detectEnvironment(page, operator);
    result = await scanTree(nav, limits, {
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      checkpoint: {
        pseudonymize: input.pseudonymize,
        resume: input.resume, // atribuição direta: o tsc confere o nome da opção (um spread condicional não confere)
        // Falha ao gravar não interrompe a leitura (o arquivo anterior continua íntegro), mas é avisada.
        save: async (snapshot) => {
          try {
            await session.save(snapshot);
          } catch (error) {
            if (checkpointFailures++ === 0) input.onCheckpointFailure?.(error instanceof Error ? error.name : 'Error');
          }
        },
      },
    });
  } finally {
    await session.release();
  }
  const finishedAt = new Date().toISOString();
  // O Chrome pode ter sido fechado à força: vale o contexto observado no início, sem perder o resultado.
  environment = await detectEnvironment(page, operator).catch(() => environment!);
  return { result, limits, checkpointFailures, meta: { runId: newRunId(new Date(startedAt)), checkpointRunId: session.runId, startedAt, finishedAt, environment } };
}

/**
 * Sempre grava o diagnóstico sem nomes. O inventário detalhado só com `detailed`, selado com a mesma
 * chave que o CheckpointStore carregou para a execução (a exportação não relê nem recria a chave).
 */
export function exportTreeRun(run: TreeRun, store: CheckpointStore, options: { detailed: boolean; outputDir?: string }): Promise<string[]> {
  const authenticator = options.detailed ? store.inventoryAuthenticator : undefined;
  return exportTreeResult(run.result, run.meta, { detailed: options.detailed, authenticator }, options.outputDir ?? DEFAULT_OUTPUT_DIR);
}

/** Execuções retomáveis a partir da pasta exibida; as demais, com o motivo (sem nomes). */
export function matchResumableRuns(entries: CheckpointEntry[], scope: CheckpointScope): { matching: CheckpointEntry[]; mismatched: Array<{ runId: string; message: string }> } {
  const valid = entries.filter((e) => !e.rejection && e.checkpoint);
  const matching: CheckpointEntry[] = [];
  const mismatched: Array<{ runId: string; message: string }> = [];
  for (const entry of valid) {
    const mismatch = compareCheckpointScope(entry.checkpoint!.scope, scope);
    if (mismatch) mismatched.push({ runId: entry.runId, message: mismatch.message });
    else matching.push(entry);
  }
  return { matching, mismatched };
}

export const pendingFolders = (checkpoint: TreeCheckpoint): number => checkpoint.folders.filter((f) => f.reasons.length > 0 || !f.settled).length;
