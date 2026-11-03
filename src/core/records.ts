import { createHash } from 'node:crypto';
import { normalizeName } from './duplicates.js';
import type { AirItem, ItemKind, RawRow, ScanIssue } from '../types/inventory.js';

/** Cabeçalhos conhecidos → campo do item. Comparação tolerante a acento/caixa. */
const COLUMN_ALIASES: Record<string, 'name' | 'description' | 'path' | 'createdAt' | 'status' | 'kind'> = {
  nome: 'name',
  descricao: 'description',
  caminho: 'path',
  'data criacao': 'createdAt',
  'data de criacao': 'createdAt',
  'criado em': 'createdAt',
  status: 'status',
  tipo: 'kind',
};

function mapColumns(row: RawRow): Partial<Record<'name' | 'description' | 'path' | 'createdAt' | 'status' | 'kind', string>> {
  const mapped: Partial<Record<'name' | 'description' | 'path' | 'createdAt' | 'status' | 'kind', string>> = {};
  for (const [header, value] of Object.entries(row.cells)) {
    const field = COLUMN_ALIASES[normalizeName(header)];
    if (field && mapped[field] === undefined) mapped[field] = value;
  }
  return mapped;
}

/**
 * Ícones da coluna de tipo do AIR, validados na UI real contra o tipo interno do item (POC-01C):
 * - pasta: <svg class="lucide-folder"> (41 linhas, todas type "digital");
 * - arquivo: <img alt="<tipo> icon"> (27 linhas "pdf icon", todas type "file").
 * Só "pdf icon" foi observado; outros alts no mesmo formato são aceitos como arquivo e o alt
 * fica na evidência. Errar aqui só pode tornar uma pasta "não abrível", nunca o contrário.
 */
export const FOLDER_TYPE_ICONS: ReadonlySet<string> = new Set(['folder']);
const FILE_TYPE_ICON = /^img:[a-z0-9]{1,10} icon$/;

export type KindClassification = { kind: ItemKind; evidence?: string };

/**
 * Tipo só é atribuído quando há pista inequívoca. A extensão no nome NÃO é usada:
 * uma pasta pode se chamar "relatorio.pdf".
 * - Com coluna de ícone (AIR real): decide só o ícone dessa coluna, por allowlist;
 *   ícone fora das listas = 'unknown' (as demais pistas da linha são ignoradas).
 * - Sem coluna de ícone: coluna "Tipo" ou pistas de ícone/rótulo da linha.
 */
export function classifyRow(row: RawRow, kindColumn?: string): KindClassification {
  if (row.typeIcon !== undefined) {
    if (FOLDER_TYPE_ICONS.has(row.typeIcon)) return { kind: 'folder', evidence: `icon:${row.typeIcon}` };
    if (FILE_TYPE_ICON.test(row.typeIcon)) return { kind: 'file', evidence: `icon:${row.typeIcon}` };
    return { kind: 'unknown' };
  }
  const sources = [kindColumn ?? '', ...row.kindHints].map((s) => normalizeName(s));
  const folder = sources.some((s) => /\b(folder|pasta|diretorio)\b/.test(s));
  const file = sources.some((s) => /\b(file|arquivo|documento|pdf)\b/.test(s));
  if (folder && !file) return { kind: 'folder', evidence: 'row-hints' };
  if (file && !folder) return { kind: 'file', evidence: 'row-hints' };
  return { kind: 'unknown' };
}

export function inferKind(row: RawRow, kindColumn?: string): ItemKind {
  return classifyRow(row, kindColumn).kind;
}

export type ParseOptions = {
  pageNumber: number;
  observedAt: string;
  /**
   * Atributo da linha aceito como ID estável. Só deve ser configurado após
   * validação manual de que o valor é estável entre recarregamentos e páginas.
   * Padrão: nenhum — sem ID comprovado, nenhum ID é atribuído.
   */
  trustedIdAttribute?: string;
};

export type ParseResult = { items: AirItem[]; issues: ScanIssue[] };

/** Converte linhas brutas em itens. Função pura, sem dependência de navegador. */
export function parseRows(rows: readonly RawRow[], options: ParseOptions): ParseResult {
  const items: AirItem[] = [];
  const issues: ScanIssue[] = [];
  const occurrences = new Map<string, number>();

  rows.forEach((row, rowIndex) => {
    const cols = mapColumns(row);
    const name = cols.name?.trim();
    if (!name) {
      issues.push({ kind: 'parse-warning', pageNumber: options.pageNumber, message: `Linha ${rowIndex + 1} sem nome; ignorada.` });
      return;
    }

    const { kind, evidence: kindEvidence } = classifyRow(row, cols.kind);
    const id = options.trustedIdAttribute ? row.idCandidates[options.trustedIdAttribute]?.trim() || undefined : undefined;

    const signature = [kind, name, cols.path ?? '', cols.createdAt ?? '', cols.description ?? '', cols.status ?? ''].join('\u0000');
    // Linhas idênticas na MESMA página são itens distintos (homônimos legítimos);
    // o índice de ocorrência os separa. Entre páginas, a mesma chave indica repetição.
    const occurrence = (occurrences.get(signature) ?? 0) + 1;
    occurrences.set(signature, occurrence);
    const observationKey = id
      ? `id:${id}`
      : `sig:${createHash('sha256').update(`${signature}\u0000${occurrence}`).digest('hex').slice(0, 24)}`;

    const identityConfidence = id ? 'stable-id' : cols.path || cols.createdAt ? 'path-and-metadata' : 'ambiguous';

    items.push({
      ...(id ? { id } : {}),
      kind,
      ...(kindEvidence ? { kindEvidence } : {}),
      name,
      ...(cols.description ? { description: cols.description } : {}),
      ...(cols.path ? { path: cols.path } : {}),
      ...(cols.createdAt ? { createdAt: cols.createdAt } : {}),
      ...(cols.status ? { status: cols.status } : {}),
      sourcePage: options.pageNumber,
      rowIndex,
      observedAt: options.observedAt,
      identityConfidence,
      observationKey,
    });
  });

  return { items, issues };
}
