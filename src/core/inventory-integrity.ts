import { timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './checkpoint.js';
import type { InventorySeal } from '../types/inventory.js';

/**
 * Integridade e procedência local do `tree-inventory.json` (POC-02B.1). Modelo puro: a chave
 * chega pronta, como um `InventoryAuthenticator` (storage/integrity-key.ts).
 *
 * O selo cobre o documento INTEIRO (nomes, caminhos, referências, contagens, status, verificação,
 * navegação, retomada, datas, ambiente) e o próprio cabeçalho. A canonicalização ordena as chaves
 * dos objetos: reordenar propriedades ou reformatar o JSON não invalida o selo; mudar qualquer
 * valor ou a ordem de um array, sim.
 *
 * Autenticado = gravado por esta instalação e inalterado desde então. Não significa que o AIR
 * ainda esteja igual (idade e completude continuam valendo) nem autoriza movimentações.
 */

export const SEAL_FORMAT = 'air-organizer/tree-inventory-seal';
export const SEAL_VERSION = 1;
/** Separação de domínio da mensagem autenticada (além da subchave própria). */
const MESSAGE_DOMAIN = `${SEAL_FORMAT}/v${SEAL_VERSION}`;

/** Subchave HMAC dos inventários. `mac` nunca expõe a chave; `keyId` é público e derivado. */
export type InventoryAuthenticator = { keyId: string; mac: (message: string) => Buffer };

export type IntegrityInvalidReason = 'malformed-seal' | 'unsupported-seal' | 'inconsistent-seal' | 'key-mismatch' | 'mac-mismatch';

export type IntegrityAssessment =
  /** Selo válido com a chave local: arquivo gravado por esta instalação e inalterado. */
  | { status: 'authenticated' }
  /**
   * Sem selo: exportação anterior à POC-02B.1 OU selo removido (indistinguíveis). Conteúdo não
   * autenticado: só exploratório, nunca promovido a elegível.
   */
  | { status: 'unsigned' }
  /** Selo presente, mas sem chave local para conferi-lo: só exploratório. */
  | { status: 'unverifiable'; reason: 'key-unavailable' }
  /** Selo presente e inválido: o inventário é recusado. */
  | { status: 'invalid'; reason: IntegrityInvalidReason };

/** Inventário sem selo: não presume que seja legado (remover o selo produz o mesmo arquivo). */
export const UNSIGNED_INVENTORY_MESSAGE = 'SEM SELO: inventário legado ou selo removido; conteúdo não autenticado.';

/** Motivos sem nomes, chaves nem códigos: podem ir ao console e ao relatório sem nomes. */
export const INTEGRITY_MESSAGES: Record<IntegrityInvalidReason, string> = {
  'malformed-seal': 'selo de integridade malformado',
  'unsupported-seal': 'formato, versão ou algoritmo do selo não suportados',
  'inconsistent-seal': 'selo com data anterior ao fim da leitura',
  'key-mismatch': 'selo de outra chave local (outra instalação ou chave recriada) ou adulterado',
  'mac-mismatch': 'código de autenticação não confere: o inventário foi alterado depois de gravado',
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Mensagem autenticada: domínio + JSON canônico do cabeçalho (sem `mac`) e do documento (sem `integrity`). */
function sealMessage(header: Omit<InventorySeal, 'mac'>, document: Record<string, unknown>): string {
  return `${MESSAGE_DOMAIN}\u0000${canonicalJson({ seal: header, document })}`;
}

/** O documento exatamente como será lido do disco (sem `undefined`, sem objetos com toJSON). */
function asStored(document: object): Record<string, unknown> {
  const { integrity: _ignored, ...body } = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  return body;
}

/**
 * Sela um inventário recém-exportado. Nunca sela de novo um documento lido do disco (ver §8.5).
 * Devolve um snapshot INDEPENDENTE do objeto recebido: o mesmo dado sobre o qual o HMAC foi
 * calculado, sem referências compartilhadas. Mudanças posteriores no original (ex.: o TreeResult)
 * não alteram o que será gravado.
 */
export function sealInventory<T extends object>(document: T, authenticator: InventoryAuthenticator, now: Date): T & { integrity: InventorySeal } {
  const header: Omit<InventorySeal, 'mac'> = {
    format: SEAL_FORMAT,
    version: SEAL_VERSION,
    algorithm: 'HMAC-SHA256',
    keyDerivation: 'HKDF-SHA256',
    canonicalization: 'canonical-json-v1',
    coverage: 'document-except-integrity',
    keyId: authenticator.keyId,
    sealedAt: now.toISOString(),
  };
  const stored = asStored(document);
  const mac = authenticator.mac(sealMessage(header, stored)).toString('hex');
  return { ...stored, integrity: { ...header, mac } } as T & { integrity: InventorySeal };
}

const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/**
 * Confere o selo. Sem `integrity` = sem selo (legado ou selo removido); selo malformado, de outra versão, de outra chave ou
 * com código divergente = inválido (comparação em tempo constante). Sem chave = não verificável.
 */
export function verifyInventoryIntegrity(input: unknown, authenticator: InventoryAuthenticator | undefined): IntegrityAssessment {
  if (!isRecord(input) || input.integrity === undefined) return { status: 'unsigned' };
  const seal = input.integrity;
  if (
    !isRecord(seal) ||
    typeof seal.format !== 'string' ||
    typeof seal.keyId !== 'string' ||
    !/^[0-9a-f]{16}$/.test(seal.keyId) ||
    typeof seal.mac !== 'string' ||
    !/^[0-9a-f]{64}$/.test(seal.mac) ||
    typeof seal.sealedAt !== 'string' ||
    !ISO.test(seal.sealedAt)
  ) {
    return { status: 'invalid', reason: 'malformed-seal' };
  }
  if (
    seal.format !== SEAL_FORMAT ||
    seal.version !== SEAL_VERSION ||
    seal.algorithm !== 'HMAC-SHA256' ||
    seal.keyDerivation !== 'HKDF-SHA256' ||
    seal.canonicalization !== 'canonical-json-v1' ||
    seal.coverage !== 'document-except-integrity' ||
    Object.keys(seal).length !== 9
  ) {
    return { status: 'invalid', reason: 'unsupported-seal' };
  }
  if (typeof input.finishedAt === 'string' && Date.parse(seal.sealedAt) < Date.parse(input.finishedAt)) return { status: 'invalid', reason: 'inconsistent-seal' };
  if (!authenticator) return { status: 'unverifiable', reason: 'key-unavailable' };
  if (!sameHex(seal.keyId, authenticator.keyId)) return { status: 'invalid', reason: 'key-mismatch' };
  const { mac, ...header } = seal as InventorySeal;
  const expected = authenticator.mac(sealMessage(header, asStored(input))).toString('hex');
  return sameHex(mac, expected) ? { status: 'authenticated' } : { status: 'invalid', reason: 'mac-mismatch' };
}
