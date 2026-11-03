import { createHash } from 'node:crypto';
import type {
  AirItem,
  DuplicateConfidence,
  DuplicateSuspicion,
  NormalizationRule,
} from '../types/inventory.js';

const ALL_RULES: readonly NormalizationRule[] = ['case', 'diacritics', 'whitespace', 'punctuation'];

/** Pontuação simples tratada como separador. Letras e dígitos nunca são removidos. */
const PUNCTUATION = /[\-_.,;:/\\|'"`´()[\]{}!?¿¡+*&#~^]/g;

/**
 * Normaliza um nome APENAS para comparação. O nome original deve ser sempre preservado.
 * Regras desabilitadas permitem descobrir quais diferenças tornaram dois nomes equivalentes.
 */
export function normalizeName(
  name: string,
  rules: readonly NormalizationRule[] = ALL_RULES,
): string {
  let value = name.normalize('NFC');
  if (rules.includes('diacritics')) {
    value = value.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
  }
  if (rules.includes('case')) {
    value = value.toLocaleLowerCase('pt-BR');
  }
  if (rules.includes('punctuation')) {
    value = value.replace(PUNCTUATION, ' ');
  }
  if (rules.includes('whitespace')) {
    value = value.replace(/\s+/gu, ' ');
  }
  return value.trim();
}

/** Regras (dentre `among`) sem as quais o grupo deixaria de ser equivalente. */
export function requiredRules(names: readonly string[], among: readonly NormalizationRule[] = ALL_RULES): NormalizationRule[] {
  return among.filter((rule) => {
    const without = among.filter((r) => r !== rule);
    return new Set(names.map((n) => normalizeName(n, without))).size > 1;
  });
}

/**
 * Alta: diferença só de maiúsculas/minúsculas, espaços ou nomes idênticos.
 * Média: exigiu remover acentos ou pontuação.
 * Similaridade parcial (ex.: "Protocolo" vs "Protocolo-2022") não gera suspeita aqui.
 */
function confidenceFor(rules: readonly NormalizationRule[]): DuplicateConfidence {
  return rules.some((r) => r === 'diacritics' || r === 'punctuation') ? 'medium' : 'high';
}

/**
 * Agrupa itens do mesmo tipo cujo nome normalizado coincide.
 * O resultado é sempre SUSPEITA de duplicidade, nunca duplicidade confirmada de conteúdo.
 */
export function findDuplicateSuspicions(items: readonly AirItem[]): DuplicateSuspicion[] {
  const groups = new Map<string, AirItem[]>();
  for (const item of items) {
    const normalized = normalizeName(item.name);
    if (normalized === '') continue;
    const key = `${item.kind}\u0000${normalized}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const suspicions: DuplicateSuspicion[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const normalizedName = key.split('\u0000')[1] ?? '';
    const matchedBy = requiredRules(group.map((i) => i.name));
    suspicions.push({
      suspicionId: createHash('sha256').update(key).digest('hex').slice(0, 12),
      normalizedName,
      matchedBy,
      confidence: confidenceFor(matchedBy),
      items: group.map(({ name, kind, path, createdAt, observationKey }) => ({
        name,
        kind,
        path,
        createdAt,
        observationKey,
      })),
      classification: 'suspected-duplicate',
      requiresHumanReview: true,
    });
  }

  return suspicions.sort((a, b) => a.normalizedName.localeCompare(b.normalizedName, 'pt-BR'));
}
