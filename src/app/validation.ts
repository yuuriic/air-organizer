import type { OperatorContext } from '../air/navigator.js';
import type { ResumeMode, TreeLimits } from '../types/inventory.js';

/** Entrada recusada; a mensagem nunca repete o valor recebido. */
export class InvalidInput extends Error {
  override readonly name = 'InvalidInput';
}

const MAX_TEXT = 200;
const LIMIT_MIN: Record<keyof TreeLimits, number> = { maxDepth: 0, maxFolders: 1, maxItems: 1, maxPagesPerFolder: 1 };

/** Mesmos mínimos da CLI. Sem teto: quem decide é o operador, e os limites nunca sobem sozinhos. */
export function parseLimits(input: unknown): TreeLimits {
  if (typeof input !== 'object' || input === null) throw new InvalidInput('Limites inválidos.');
  const raw = input as Record<string, unknown>;
  const out = {} as TreeLimits;
  for (const key of Object.keys(LIMIT_MIN) as Array<keyof TreeLimits>) {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < LIMIT_MIN[key]) throw new InvalidInput(`Limite inválido: informe um inteiro >= ${LIMIT_MIN[key]} em cada campo.`);
    out[key] = value;
  }
  return out;
}

export function parseText(input: unknown, label: string): string {
  if (input === undefined || input === null) return '';
  // eslint-disable-next-line no-control-regex
  if (typeof input !== 'string' || input.length > MAX_TEXT || /[\u0000-\u001f\u007f]/.test(input)) throw new InvalidInput(`${label} inválido.`);
  return input.trim();
}

/** Cliente e setor são informados pelo operador. Vazio mantém o valor anterior da sessão, como na CLI. */
export function parseOperator(input: unknown, current: OperatorContext): OperatorContext {
  if (input === undefined || input === null) return current;
  if (typeof input !== 'object') throw new InvalidInput('Contexto inválido.');
  const raw = input as Record<string, unknown>;
  const client = parseText(raw.client, 'Cliente') || current.client;
  const sector = parseText(raw.sector, 'Setor') || current.sector;
  return { ...(client ? { client } : {}), ...(sector ? { sector } : {}) };
}

export function parseResumeMode(input: unknown): ResumeMode {
  if (input === 'verified' || input === 'fast') return input;
  throw new InvalidInput('Modo de retomada inválido.');
}
