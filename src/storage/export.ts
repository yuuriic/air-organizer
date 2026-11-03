import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeName } from '../core/duplicates.js';
import { assertInsideDirectory } from '../safety/scope-validator.js';
import { diagnosticReport } from '../core/tree-scanner.js';
import type { AirEnvironment, Identified, Inventory, TreeResult } from '../types/inventory.js';

export const DEFAULT_OUTPUT_DIR = 'output';

/** Segmento de diretório seguro: ASCII, sem separadores, com hash curto contra colisões. */
export function safeSegment(label: string): string {
  const slug = normalizeName(label)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const hash = createHash('sha256').update(label).digest('hex').slice(0, 8);
  return `${slug || 'x'}-${hash}`;
}

function segmentFor(field: Identified<string>, fallback: string): string {
  return field.status === 'identified' ? safeSegment(field.value) : fallback;
}

export function newRunId(date = new Date()): string {
  return `${date.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

/** output/<instância>/<setor>/<runId>/inventory.json */
export function inventoryPath(inventory: Inventory, outputDir = DEFAULT_OUTPUT_DIR): string {
  const instance = segmentFor(inventory.environment.instanceOrigin, 'instancia-nao-identificada');
  const sector = segmentFor(inventory.environment.sector, 'setor-nao-identificado');
  const runId = safeSegment(inventory.runId);
  return assertInsideDirectory(outputDir, path.join(instance, sector, runId, 'inventory.json'));
}

/**
 * Grava o inventário IDENTIFICÁVEL (nomes, caminhos, URLs) com escrita atômica.
 * Só deve ser chamado após confirmação explícita do usuário; ver `exportInventoryResult`.
 */
export async function exportInventory(inventory: Inventory, outputDir = DEFAULT_OUTPUT_DIR): Promise<string> {
  return writeAtomic(inventoryPath(inventory, outputDir), inventory);
}

/**
 * Relatório da leitura de uma pasta sem dados identificáveis: só status de identificação,
 * contagens, tipos de pendência e confiança das suspeitas. Sem nomes, caminhos, URLs,
 * cliente, setor ou mensagens (que podem citar nomes).
 */
export function inventoryDiagnostic(inventory: Inventory) {
  const { environment: env, coverage, items, duplicateSuspicions } = inventory;
  const count = <T extends string>(values: T[]) => values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
  return {
    environment: Object.fromEntries(
      (['instanceOrigin', 'pageUrl', 'client', 'sector', 'currentFolder', 'breadcrumb'] as const).map((k) => [k, env[k].status]),
    ),
    coverage: {
      ...coverage,
      issues: coverage.issues.map(({ kind, pageNumber }) => (pageNumber === undefined ? { kind } : { kind, pageNumber })),
    },
    itemKinds: count(items.map((i) => i.kind)),
    duplicateSuspicions: { total: duplicateSuspicions.length, byConfidence: count(duplicateSuspicions.map((s) => s.confidence)) },
  };
}

/**
 * Exporta a leitura de uma pasta (opção 5). Padrão: só o relatório diagnóstico
 * (output/<instância>/<setor>/<runId>/inventory-diagnostic.json). O inventário identificável
 * (inventory.json) só é gravado com `detailed: true`, que exige confirmação explícita em quem chama.
 */
export async function exportInventoryResult(inventory: Inventory, options: { detailed: boolean }, outputDir = DEFAULT_OUTPUT_DIR): Promise<string[]> {
  const detailedPath = inventoryPath(inventory, outputDir);
  const base = { schemaVersion: inventory.schemaVersion, tool: inventory.tool, mode: inventory.mode, readOnly: true, runId: inventory.runId, startedAt: inventory.startedAt, finishedAt: inventory.finishedAt };
  const written = [await writeAtomic(path.join(path.dirname(detailedPath), 'inventory-diagnostic.json'), { ...base, identifiable: false, ...inventoryDiagnostic(inventory) })];
  if (options.detailed) written.push(await exportInventory(inventory, outputDir));
  return written;
}

/**
 * Caminho de um arquivo exportado para exibição no console: os segmentos de instância e setor
 * (derivados do domínio e do nome do setor) são trocados por "*". O resultado continua
 * utilizável como padrão de busca com curingas (ex.: Get-ChildItem no PowerShell).
 */
export function displayPath(file: string, outputDir = DEFAULT_OUTPUT_DIR): string {
  const parts = path.relative(path.resolve(outputDir), file).split(path.sep);
  if (parts.length !== 4) return '(caminho omitido)';
  return [outputDir, '*', '*', parts[2], parts[3]].join('/');
}

export type TreeRunMeta = { runId: string; startedAt: string; finishedAt: string; environment: AirEnvironment };

/**
 * Exporta a leitura recursiva. Padrão: só o relatório diagnóstico, sem dados identificáveis
 * (output/<instância>/<setor>/<runId>/tree-diagnostic.json). O inventário detalhado — nomes,
 * caminhos, URLs e mensagens — só é gravado com `detailed: true`, que exige confirmação explícita
 * do usuário (e observância das políticas da empresa) em quem chama.
 */
export async function exportTreeResult(
  result: TreeResult,
  meta: TreeRunMeta,
  options: { detailed: boolean },
  outputDir = DEFAULT_OUTPUT_DIR,
): Promise<string[]> {
  const base = { schemaVersion: 2, tool: 'air-organizer', mode: 'recursive', readOnly: true, runId: meta.runId, startedAt: meta.startedAt, finishedAt: meta.finishedAt };
  const dir = path.dirname(
    assertInsideDirectory(
      outputDir,
      path.join(segmentFor(meta.environment.instanceOrigin, 'instancia-nao-identificada'), segmentFor(meta.environment.sector, 'setor-nao-identificado'), safeSegment(meta.runId), 'x'),
    ),
  );
  const written = [await writeAtomic(path.join(dir, 'tree-diagnostic.json'), { ...base, identifiable: false, ...diagnosticReport(result) })];
  if (options.detailed) {
    written.push(await writeAtomic(path.join(dir, 'tree-inventory.json'), { ...base, identifiable: true, environment: meta.environment, ...result }));
  }
  return written;
}

async function writeAtomic(target: string, data: unknown): Promise<string> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf-8', flag: 'wx' });
  await rename(temp, target);
  return target;
}
