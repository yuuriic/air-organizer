import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isIsoTimestamp, redactReport, type StructuralReport } from '../core/structural-diagnostics.js';
import { SafetyViolation, assertInsideDirectory } from '../safety/scope-validator.js';
import { DEFAULT_OUTPUT_DIR, writeAtomic } from './export.js';

/**
 * Inventários recursivos exportados (tree-inventory.json, identificáveis) e os relatórios de
 * diagnóstico estrutural gravados ao lado deles. Tudo dentro de output/ (fora do Git).
 */

export type TreeInventoryFile = { file: string; finishedAt?: string; status?: string };

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const LISTED_STATUSES: readonly string[] = ['complete', 'partial', 'failed'];

/**
 * Motivo de uma falha da opção 8 (leitura de inventário ou gravação de relatório em output/),
 * próprio do processamento local e sem dados identificáveis: a mensagem original do erro pode
 * citar caminhos (instância, setor) ou trechos do arquivo (nomes), e não é reproduzida.
 */
export function describeLocalFailure(error: unknown): string {
  if (error instanceof SyntaxError) return 'o inventário não é um JSON válido (arquivo corrompido ou incompleto); nenhum diagnóstico foi produzido.';
  if (error instanceof SafetyViolation) return 'o arquivo está fora do diretório output/ e não foi acessado.';
  const code = errorCode(error);
  if (code === 'ENOENT') return 'arquivo ou diretório não encontrado em output/ (pode ter sido removido ou movido depois da listagem).';
  if (code === 'EACCES' || code === 'EPERM') return 'sem permissão para acessar o arquivo em output/.';
  if (code === 'EBUSY') return 'o arquivo está em uso por outro programa.';
  if (code === 'ENOSPC') return 'sem espaço em disco para gravar o relatório.';
  if (code === 'EEXIST') return 'já existe um arquivo temporário da gravação; tente novamente.';
  return `falha no acesso local aos arquivos de output/${code && /^[A-Z0-9_]+$/.test(code) ? ` (código ${code})` : ''}.`;
}

/** output/<instância>/<setor>/<execução>/tree-inventory.json, do mais recente ao mais antigo. */
export async function listTreeInventories(outputDir = DEFAULT_OUTPUT_DIR): Promise<TreeInventoryFile[]> {
  const dirs = async (p: string) => {
    try {
      return (await readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  };
  const found: TreeInventoryFile[] = [];
  for (const a of await dirs(path.resolve(outputDir))) {
    for (const b of await dirs(a)) {
      for (const run of await dirs(b)) {
        const file = path.join(run, 'tree-inventory.json');
        const runFiles = await readdir(run, { withFileTypes: true });
        if (!runFiles.some((entry) => entry.isFile() && entry.name === 'tree-inventory.json')) continue;
        try {
          const doc: unknown = JSON.parse(await readFile(file, 'utf-8'));
          found.push({
            file,
            // Exibidos no console padrão: só valores no formato esperado, nunca o texto do arquivo.
            ...(isRecord(doc) && isIsoTimestamp(doc.finishedAt) ? { finishedAt: doc.finishedAt } : {}),
            status: isRecord(doc) ? (LISTED_STATUSES.includes(doc.status as string) ? (doc.status as string) : 'desconhecido') : 'inválido',
          });
        } catch (error) {
          if (error instanceof SyntaxError) {
            found.push({ file, status: 'inválido' });
          } else if (errorCode(error) !== 'ENOENT') {
            throw error;
          }
        }
      }
    }
  }
  return found.sort((x, y) => (y.finishedAt ?? '').localeCompare(x.finishedAt ?? ''));
}

/** Lê o inventário sem mascarar falhas de acesso ou JSON inválido. */
export async function readInventory(file: string, outputDir = DEFAULT_OUTPUT_DIR): Promise<unknown> {
  const safe = assertInsideDirectory(outputDir, path.relative(path.resolve(outputDir), path.resolve(file)));
  return JSON.parse(await readFile(safe, 'utf-8')) as unknown;
}

/**
 * Grava o relatório ao lado do inventário: sempre `structural-diagnostics.json` (sem nomes,
 * caminhos nem grafias); `structural-diagnostics-detailed.json` (identificável) só com `detailed`.
 */
export async function exportStructuralReport(
  report: StructuralReport,
  inventoryFile: string,
  options: { detailed: boolean },
  outputDir = DEFAULT_OUTPUT_DIR,
): Promise<string[]> {
  const dir = path.dirname(assertInsideDirectory(outputDir, path.relative(path.resolve(outputDir), path.resolve(inventoryFile))));
  const written = [await writeAtomic(path.join(dir, 'structural-diagnostics.json'), redactReport(report))];
  if (options.detailed) written.push(await writeAtomic(path.join(dir, 'structural-diagnostics-detailed.json'), report));
  return written;
}
