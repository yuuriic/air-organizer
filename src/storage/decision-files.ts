import { randomBytes } from 'node:crypto';
import { constants, copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { InventoryAuthenticator } from '../core/inventory-integrity.js';
import { isInventoryId, parseDecisionDocument, sealDecisions, type DecisionRecord } from '../core/movement-decisions.js';
import { assertOutsideRepository } from '../safety/scope-validator.js';
import { writeAtomic } from './checkpoints.js';

/**
 * Histórico local de decisões humanas (POC-03B, Incremento B): um JSON por inventário autenticado, no
 * perfil do usuário (`<perfil>/air-organizer/decisions/<inventário>.json`), fora do repositório e fora
 * de `output/`. O nome do arquivo é o identificador do inventário, que não contém nomes.
 *
 * Arquivo inválido bloqueia novas decisões e nunca é sobrescrito sem cópia: um novo histórico só começa
 * por `startNewDecisionHistory`, depois de confirmação do operador, e nada do arquivo inválido é importado.
 */

export class InvalidDecisionHistory extends Error {
  constructor() {
    super('Histórico local de decisões inválido.');
    this.name = 'InvalidDecisionHistory';
  }
}

export type DecisionFileStatus = 'absent' | 'valid' | 'invalid';
export type LoadedDecisions = { status: DecisionFileStatus; records: DecisionRecord[] };

/** Teto do arquivo: maior que isso é tratado como inválido na leitura e recusado na gravação. */
export const MAX_DECISION_FILE_BYTES = 32 * 1024 * 1024;

/** Mesma pasta da chave local: a pasta das decisões não acompanha o diretório de checkpoints. */
export const decisionsDirectory = (keyFile: string) => path.join(path.dirname(keyFile), 'decisions');

function fileOf(dir: string, inventoryId: string): string {
  if (!isInventoryId(inventoryId)) throw new TypeError('Identificador de inventário inválido.');
  const file = path.join(path.resolve(dir), `${inventoryId}.json`);
  assertOutsideRepository([file]);
  return file;
}

export async function loadDecisions(dir: string, inventoryId: string, auth: InventoryAuthenticator): Promise<LoadedDecisions> {
  const file = fileOf(dir, inventoryId);
  let text: string;
  try {
    if ((await stat(file)).size > MAX_DECISION_FILE_BYTES) return { status: 'invalid', records: [] };
    text = await readFile(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent', records: [] };
    throw error; // Falha de leitura não é arquivo inválido: nada é guardado à parte por causa dela.
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { status: 'invalid', records: [] };
  }
  const records = parseDecisionDocument(input, inventoryId, auth);
  return records ? { status: 'valid', records } : { status: 'invalid', records: [] };
}

/** Acrescenta ao histórico, sem reescrever registros anteriores. Escrita atômica. */
export async function appendDecision(dir: string, record: DecisionRecord, auth: InventoryAuthenticator): Promise<void> {
  const file = fileOf(dir, record.inventoryId);
  const loaded = await loadDecisions(dir, record.inventoryId, auth);
  if (loaded.status === 'invalid') throw new InvalidDecisionHistory();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(sealDecisions(record.inventoryId, [...loaded.records, record], auth), null, 2);
  if (Buffer.byteLength(text, 'utf-8') > MAX_DECISION_FILE_BYTES) throw new RangeError('Histórico de decisões acima do limite local.');
  await writeAtomic(file, text);
}

/**
 * Guarda o arquivo inválido como cópia de recuperação e só então grava um histórico novo e vazio. Recusa
 * histórico válido ou ausente: nada que possa ser conferido passa por aqui. Quem chama confirma antes.
 */
export async function startNewDecisionHistory(dir: string, inventoryId: string, auth: InventoryAuthenticator, now: Date): Promise<void> {
  const file = fileOf(dir, inventoryId);
  if ((await loadDecisions(dir, inventoryId, auth)).status !== 'invalid') throw new TypeError('Só um histórico inválido pode ser substituído.');
  const copy = `${file.slice(0, -'.json'.length)}.invalido-${now.getTime()}-${randomBytes(4).toString('hex')}.bak`;
  await copyFile(file, copy, constants.COPYFILE_EXCL);
  await writeAtomic(file, JSON.stringify(sealDecisions(inventoryId, [], auth), null, 2));
}
