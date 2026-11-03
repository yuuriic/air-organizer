import { createHmac, hkdfSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { InventoryAuthenticator } from '../core/inventory-integrity.js';
import { assertOutsideRepository } from '../safety/scope-validator.js';

/**
 * Subchave de autenticação dos inventários (POC-02B.1). Reaproveita a chave-mestra local dos
 * checkpoints (perfil do usuário, fora do repositório, ADR-010) e deriva dela, por HKDF-SHA256,
 * uma subchave própria: os checkpoints usam a chave-mestra diretamente (pseudônimos e digest),
 * os inventários só a subchave. Nenhum valor de chave é registrado ou exibido.
 *
 * Para GRAVAR (opções 6/7), o autenticador vem do `CheckpointStore` da execução
 * (`store.inventoryAuthenticator`), derivado da chave já carregada: a exportação não relê nem
 * recria a chave do disco.
 */

const HKDF_SALT = 'air-organizer/key-derivation';
const HKDF_INFO = 'tree-inventory-seal/v1';
const KEY_ID_LABEL = 'air-organizer/tree-inventory-seal/key-id';

export function inventoryAuthenticator(masterKey: Buffer): InventoryAuthenticator {
  const subkey = Buffer.from(hkdfSync('sha256', masterKey, HKDF_SALT, HKDF_INFO, 32));
  return {
    keyId: createHmac('sha256', subkey).update(KEY_ID_LABEL, 'utf8').digest('hex').slice(0, 16),
    mac: (message) => createHmac('sha256', subkey).update(message, 'utf8').digest(),
  };
}

export type KeyUnavailable = 'missing' | 'invalid' | 'unreadable';

/**
 * Para VERIFICAR (opção 8): nunca cria a chave. Chave ausente, ilegível, malformada ou dentro do
 * repositório = indisponível (selos ficam não verificáveis, nunca elegíveis). O motivo não contém
 * caminho nem conteúdo.
 */
export async function openVerifyingAuthenticator(
  keyFile: string,
  repositoryDir?: string,
): Promise<{ authenticator: InventoryAuthenticator } | { unavailable: KeyUnavailable }> {
  try {
    assertOutsideRepository([keyFile], repositoryDir);
  } catch {
    return { unavailable: 'invalid' };
  }
  let hex: string;
  try {
    hex = (await readFile(keyFile, 'utf-8')).trim();
  } catch (error) {
    return { unavailable: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (!/^[0-9a-f]{64}$/.test(hex)) return { unavailable: 'invalid' };
  return { authenticator: inventoryAuthenticator(Buffer.from(hex, 'hex')) };
}
