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
const DECISIONS_HKDF_INFO = 'movement-decisions/v1';
const DECISIONS_KEY_ID_LABEL = 'air-organizer/movement-decisions/key-id';

function derivedAuthenticator(masterKey: Buffer, info: string, keyIdLabel: string): InventoryAuthenticator {
  const subkey = Buffer.from(hkdfSync('sha256', masterKey, HKDF_SALT, info, 32));
  return {
    keyId: createHmac('sha256', subkey).update(keyIdLabel, 'utf8').digest('hex').slice(0, 16),
    mac: (message) => createHmac('sha256', subkey).update(message, 'utf8').digest(),
  };
}

export const inventoryAuthenticator = (masterKey: Buffer): InventoryAuthenticator => derivedAuthenticator(masterKey, HKDF_INFO, KEY_ID_LABEL);

/** Subchave própria das decisões humanas: um selo de inventário nunca serve de selo de decisões. */
export const decisionAuthenticator = (masterKey: Buffer): InventoryAuthenticator => derivedAuthenticator(masterKey, DECISIONS_HKDF_INFO, DECISIONS_KEY_ID_LABEL);

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
  const key = await readMasterKey(keyFile, repositoryDir);
  return 'key' in key ? { authenticator: inventoryAuthenticator(key.key) } : key;
}

/** Nunca cria a chave: sem ela, não há decisões a conferir nem a gravar. */
export async function openDecisionAuthenticator(keyFile: string, repositoryDir?: string): Promise<InventoryAuthenticator | undefined> {
  const key = await readMasterKey(keyFile, repositoryDir);
  return 'key' in key ? decisionAuthenticator(key.key) : undefined;
}

async function readMasterKey(keyFile: string, repositoryDir?: string): Promise<{ key: Buffer } | { unavailable: KeyUnavailable }> {
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
  return { key: Buffer.from(hex, 'hex') };
}
