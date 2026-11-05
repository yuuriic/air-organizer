import { createHash } from 'node:crypto';
import { normalizeName, requiredRules } from './duplicates.js';
import { INTEGRITY_MESSAGES, verifyInventoryIntegrity, type IntegrityAssessment, type InventoryAuthenticator } from './inventory-integrity.js';
import type { FolderNode, FolderStatus, NormalizationRule, ResumeMode, TreeInventoryExport } from '../types/inventory.js';

/**
 * Diagnóstico estrutural (POC-02A). Motor DETERMINÍSTICO e puro — sem navegador, sem sistema de
 * arquivos, sem rede: recebe um inventário recursivo exportado (`tree-inventory.json`) e devolve
 * achados para REVISÃO HUMANA. Não recomenda renomear, mover nem mesclar nada.
 *
 * Mesmo inventário + mesmo `now` = mesmo relatório, byte a byte.
 *
 * Elegibilidade (§8.4): o motor não recalcula a completude — reutiliza `verification`,
 * `navigation`, `resume` e `status` da leitura. Achados de inventário não elegível são só
 * exploratórios; inventário internamente inconsistente é recusado sem achados.
 *
 * Integridade (§8.5, POC-02B.1): só inventário com selo autenticado pela chave local pode ser
 * elegível. Sem selo (legado ou selo removido) ou sem chave = exploratório; selo inválido = recusado. Autenticado
 * não quer dizer atual: completude, retomada e idade continuam valendo.
 */

export const ENGINE_VERSION = '1';

export type DiagnosticCategory = 'possible-duplicate' | 'inconsistent-naming' | 'divergent-hierarchy';

/** Regras aplicadas. Cada achado registra a que o produziu. */
export type DiagnosticRule =
  /** Pastas irmãs (mesmo pai) com nomes idênticos. */
  | 'DUP-SIBLING-EXACT'
  /** Pastas irmãs com nomes equivalentes após normalização (caixa, acento, espaço, pontuação). */
  | 'DUP-SIBLING-NORMALIZED'
  /** O mesmo nome grafado de formas diferentes (caixa, acento, espaços) em pais diferentes. */
  | 'NAME-VARIANTS'
  /** Nome com espaço no início/fim ou espaços repetidos. */
  | 'NAME-SPACING'
  /** Subpasta com o mesmo nome (normalizado) da pasta que a contém. */
  | 'HIER-NESTED-SAME-NAME'
  /** Pastas equivalentes (mesmo nome normalizado, pais diferentes) cujos conjuntos de subpastas quase coincidem. */
  | 'HIER-EQUIVALENT-CHILDREN';

/**
 * Grau de certeza da DETECÇÃO (não da existência de um problema), sem probabilidades:
 * 'exact' = textos idênticos; 'normalized' = equivalentes pelas regras listadas em `matchedBy`;
 * 'structural' = padrão de estrutura que atingiu os limiares documentados.
 */
export type Certainty = 'exact' | 'normalized' | 'structural';

/** Pasta envolvida num achado. `name`/`path` só no relatório detalhado (identificável). */
export type FolderEvidence = {
  ref: string;
  parentRef?: string;
  depth: number;
  status: FolderStatus;
  /** Contagens da listagem própria, só quando a pasta foi lida. */
  counts?: { items: number; folders: number; files: number };
  name?: string;
  path?: string;
};

export type StructuralFinding = {
  /** Estável para o mesmo inventário: hash da regra e das referências envolvidas. */
  id: string;
  category: DiagnosticCategory;
  rule: DiagnosticRule;
  certainty: Certainty;
  matchedBy?: NormalizationRule[];
  /** Descrição sem nomes, caminhos nem identificadores. */
  summary: string;
  folders: FolderEvidence[];
  /** Medidas da regra (contagens); nomes só no relatório detalhado. */
  measures?: Record<string, number>;
  /** Grafias e nomes de subpastas envolvidos — só no relatório detalhado. */
  names?: { variants?: string[]; common?: string[]; onlyIn?: Record<string, string[]> };
  relatedFindings?: string[];
  limitations: string[];
  requiresHumanReview: true;
};

export type EligibilityReason =
  /** Sem selo de integridade (exportação anterior à POC-02B.1). */
  | 'integrity-unsigned'
  /** Selo presente, mas sem chave local para conferi-lo. */
  | 'integrity-unverifiable'
  | 'legacy-format'
  | 'status-partial'
  | 'status-failed'
  | 'aborted'
  | 'fast-resume'
  | 'reused-folders'
  | 'content-changed'
  | 'not-eligible-for-planning'
  | 'stale';

export type InventoryEligibility =
  /** Selo autenticado; leitura completa, revalidada, sem divergência, recente: pode fundamentar planejamento (POC-02B). */
  | { status: 'planning-eligible'; reasons: [] }
  /** Inventário consistente, mas não elegível: achados só para exploração. */
  | { status: 'exploratory'; reasons: EligibilityReason[] }
  /** Inventário inconsistente ou ilegível: nenhum achado é produzido. */
  | { status: 'rejected'; reasons: string[] };

export type StructuralReport = {
  kind: 'air-organizer/structural-diagnostics';
  /** 2: `integrity` e `completeness` (POC-02B.1). */
  schemaVersion: 2;
  engineVersion: string;
  identifiable: boolean;
  evaluatedAt: string;
  source: { runId?: string; checkpointRunId?: string; finishedAt?: string; status?: string; resumeMode?: string };
  /** O arquivo foi gravado por esta instalação e não mudou? (sem chave nem código no relatório) */
  integrity: IntegrityAssessment;
  /** O que a leitura cobriu, como ela mesma declarou. Ausente em inventário recusado. */
  completeness?: { status: 'complete' | 'partial' | 'failed'; contentRevalidated?: boolean; resumeMode?: ResumeMode };
  /** Pode fundamentar planejamento? Combina integridade, completude, retomada e idade. */
  eligibility: InventoryEligibility;
  coverage: {
    folders: number;
    foldersWithName: number;
    /** Pastas cuja listagem foi lida (completa ou parcial). */
    foldersRead: number;
    /** Pastas com listagem completa — as únicas usadas nas regras de hierarquia. */
    foldersComplete: number;
  };
  summary: { findings: number; byCategory: Record<DiagnosticCategory, number>; byRule: Partial<Record<DiagnosticRule, number>> };
  findings: StructuralFinding[];
};

export type AnalyzeOptions = {
  /** Referência de tempo (relatório determinístico para o mesmo `now`). */
  now: Date;
  /** Inventário mais antigo que isto é desatualizado para planejamento. Padrão: 7 dias. */
  maxAgeDays?: number;
  /** Subchave local dos selos. Ausente = selos não verificáveis: nada é elegível (falha segura). */
  authenticator?: InventoryAuthenticator;
};

/* Limiares conservadores de HIER-EQUIVALENT-CHILDREN (preferir falso negativo a falso positivo). */
const MIN_COMMON_CHILDREN = 2;
const MIN_JACCARD = 0.5;
/** Normalização da categoria B: só caixa, acento e espaços (pontuação muda o nome, não a grafia). */
const SPELLING_RULES: readonly NormalizationRule[] = ['case', 'diacritics', 'whitespace'];
const CATEGORY_ORDER: DiagnosticCategory[] = ['possible-duplicate', 'inconsistent-naming', 'divergent-hierarchy'];
const FOLDER_STATUSES: readonly FolderStatus[] = ['complete', 'partial', 'failed', 'skipped'];

const isRead = (f: FolderNode) => f.status === 'complete' || f.status === 'partial';
const refNumber = (ref: string) => Number(ref.slice(1));
export const byRef = (a: { ref: string }, b: { ref: string }) => refNumber(a.ref) - refNumber(b.ref);
const findingId = (rule: DiagnosticRule, refs: string[]) => createHash('sha256').update(`${rule}|${[...refs].sort().join(',')}`).digest('hex').slice(0, 12);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
/**
 * Data como a exportação grava (`toISOString()`). `Date.parse` sozinho aceita textos como
 * "Fulano 2026", que chegariam ao relatório sem nomes (`source.finishedAt`) e ao console.
 */
export const isIsoTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const isDate = isIsoTimestamp;
const isRef = (value: unknown): value is string => typeof value === 'string' && /^F[1-9]\d*$/.test(value);
/**
 * Referência para os motivos de recusa (exibidos no console padrão): só o formato F<n>. Num
 * inventário malformado, `ref`/`parentRef` podem conter qualquer texto — nomes, CPFs, URLs, tokens.
 */
const refLabel = (value: unknown) => (isRef(value) ? value : 'pasta com referência inválida');
const hasCounts = (value: unknown, keys: readonly string[]) => isRecord(value) && keys.every((key) => isCount(value[key]));

function isInventoryItem(value: unknown): boolean {
  return isRecord(value) && (value.kind === 'folder' || value.kind === 'file' || value.kind === 'unknown') && typeof value.name === 'string';
}

function isFolderNode(value: unknown): value is FolderNode {
  if (!isRecord(value) || !isRecord(value.counts)) return false;
  const counts = value.counts;
  return (
    typeof value.ref === 'string' &&
    (value.parentRef === undefined || typeof value.parentRef === 'string') &&
    Number.isInteger(value.depth) &&
    typeof value.depth === 'number' &&
    value.depth >= 0 &&
    FOLDER_STATUSES.includes(value.status as FolderStatus) &&
    FOLDER_STATUSES.includes(value.subtreeStatus as FolderStatus) &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === 'string') &&
    ['items', 'folders', 'files', 'unknown', 'locationMismatch', 'pagesRead'].every((key) => isCount(counts[key])) &&
    Array.isArray(counts.unreadPages) &&
    counts.unreadPages.every(isCount) &&
    Array.isArray(value.issueKinds) &&
    value.issueKinds.every((kind) => typeof kind === 'string') &&
    Array.isArray(value.items) &&
    value.items.every(isInventoryItem) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every((message) => typeof message === 'string') &&
    (value.reusedFrom === undefined || typeof value.reusedFrom === 'string') &&
    (value.verification === undefined || ['unchanged', 'changed', 'new', 'reused'].includes(String(value.verification))) &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.path === undefined || typeof value.path === 'string')
  );
}

/**
 * Consistência interna do inventário. Qualquer falha = 'rejected' (falha segura): achados sobre
 * uma hierarquia mal formada seriam enganosos.
 */
export function validateInventory(inv: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(inv)) return ['documento ausente ou não é um objeto'];
  const doc = inv as Partial<TreeInventoryExport>;
  if (doc.tool !== 'air-organizer' || doc.mode !== 'recursive' || doc.schemaVersion !== 2) problems.push('não é um inventário recursivo do AIR Organizer (schemaVersion 2)');
  if (doc.identifiable !== true) problems.push('inventário sem dados identificáveis (tree-diagnostic.json não tem nomes; use tree-inventory.json)');
  if (doc.readOnly !== true) problems.push('inventário não declara modo somente leitura');
  if (typeof doc.runId !== 'string' || !doc.runId.trim()) problems.push('identificador local da execução ausente');
  if (!isDate(doc.startedAt) || !isDate(doc.finishedAt)) problems.push('datas da execução ausentes ou inválidas');
  if (!isRecord(doc.environment)) problems.push('contexto do inventário ausente ou inválido');
  if (doc.status !== 'complete' && doc.status !== 'partial' && doc.status !== 'failed') problems.push('status geral do inventário inválido');
  if (doc.checkpointRunId !== undefined && typeof doc.checkpointRunId !== 'string') problems.push('identificador local do checkpoint inválido');
  if (doc.verification !== undefined && (!isRecord(doc.verification) || typeof doc.verification.contentRevalidated !== 'boolean' || typeof doc.verification.eligibleForPlanning !== 'boolean')) {
    problems.push('verificação da leitura ausente ou inválida');
  }
  if (doc.navigation !== undefined && !hasCounts(doc.navigation, ['contentChanged', 'identityMismatch', 'navigationFailed'])) {
    problems.push('diagnósticos de navegação ausentes ou inválidos');
  }
  if (
    doc.resume !== undefined &&
    (!isRecord(doc.resume) ||
      (doc.resume.mode !== 'fast' && doc.resume.mode !== 'verified') ||
      !hasCounts(doc.resume, ['reusedFolders', 'unchanged', 'changed', 'new', 'removed']) ||
      (doc.resume.oldestReusedObservation !== undefined && typeof doc.resume.oldestReusedObservation !== 'string'))
  ) {
    problems.push('metadados da retomada ausentes ou inválidos');
  }
  if (doc.abort !== undefined && (!isRecord(doc.abort) || typeof doc.abort.atRef !== 'string' || typeof doc.abort.message !== 'string')) {
    problems.push('metadados de interrupção ausentes ou inválidos');
  }
  if (!Array.isArray(doc.folders) || doc.folders.length === 0) return [...problems, 'lista de pastas ausente ou vazia'];
  if (!doc.folders.every(isFolderNode)) return [...problems, 'estrutura de pasta, contagem ou item inválida'];

  // Ordem do arquivo não importa: subpastas são pareadas com as linhas do pai pela ordem das referências.
  const folders = [...doc.folders].sort(byRef);
  const refs = new Map<string, FolderNode>();
  for (const f of folders) {
    if (!isRef(f.ref)) problems.push('referência de pasta inválida');
    else if (refs.has(f.ref)) problems.push(`referência repetida: ${f.ref}`);
    else refs.set(f.ref, f);
  }
  const roots = folders.filter((f) => !f.parentRef);
  if (roots.length !== 1) problems.push(`esperada 1 pasta inicial, encontradas ${roots.length}`);
  else if (roots[0]!.depth !== 0) problems.push('pasta inicial com profundidade diferente de 0');

  // Daqui em diante, toda referência citada num motivo passa por refLabel.
  const children = new Map<string, FolderNode[]>();
  for (const f of folders) {
    if (!f.parentRef) continue;
    if (!isRef(f.parentRef)) {
      problems.push(`${refLabel(f.ref)}: referência do pai inválida`);
      continue;
    }
    const parent = refs.get(f.parentRef);
    if (!parent) {
      problems.push(`${refLabel(f.ref)}: pai ${f.parentRef} inexistente`);
      continue;
    }
    if (f.depth !== parent.depth + 1) problems.push(`${refLabel(f.ref)}: profundidade incoerente com o pai`);
    children.set(parent.ref, [...(children.get(parent.ref) ?? []), f]);
  }
  for (const f of folders) {
    const ref = refLabel(f.ref);
    if (!Array.isArray(f.items) || !f.counts) {
      problems.push(`${ref}: itens ou contagens ausentes`);
      continue;
    }
    if (!isRead(f) || f.reusedFrom) continue; // sem listagem própria nesta exportação
    const folderItems = f.items.filter((i) => i.kind === 'folder');
    const fileItems = f.items.filter((i) => i.kind === 'file');
    const unknownItems = f.items.filter((i) => i.kind === 'unknown');
    if (f.counts.items !== f.items.length) problems.push(`${ref}: contagem de itens diverge da listagem`);
    if (f.counts.folders !== folderItems.length) problems.push(`${ref}: contagem de pastas diverge da listagem`);
    if (f.counts.files !== fileItems.length) problems.push(`${ref}: contagem de arquivos diverge da listagem`);
    if (f.counts.unknown !== unknownItems.length) problems.push(`${ref}: contagem de itens desconhecidos diverge da listagem`);
    const kids = children.get(f.ref) ?? [];
    if (kids.length !== folderItems.length) problems.push(`${ref}: subpastas registradas divergem das pastas listadas`);
    else
      kids.forEach((k, i) => {
        if (k.name !== undefined && k.name !== folderItems[i]!.name) problems.push(`${refLabel(k.ref)}: nome diverge da linha correspondente no pai`);
        if (k.path !== undefined && f.path !== undefined && k.path !== `${f.path}/${k.name}`) problems.push(`${refLabel(k.ref)}: caminho incoerente com o do pai`);
      });
  }
  if (doc.status === 'complete' && folders.some((f) => f.status !== 'complete' || f.subtreeStatus !== 'complete')) {
    problems.push('status geral completo diverge do status das pastas');
  }
  if (
    doc.verification &&
    isRecord(doc.verification) &&
    doc.verification.eligibleForPlanning === true &&
    (doc.status !== 'complete' ||
      doc.verification.contentRevalidated !== true ||
      folders.some((f) => f.status !== 'complete' || f.subtreeStatus !== 'complete' || f.reusedFrom !== undefined) ||
      (isRecord(doc.navigation) && doc.navigation.contentChanged !== 0))
  ) {
    problems.push('elegibilidade declarada diverge da verificação e da estrutura');
  }
  return [...new Set(problems)];
}

/**
 * Elegibilidade a partir da integridade e do que a leitura já declarou (não é recalculada).
 * Ordem (§8.5): integridade, completude e retomada, idade. Selo inválido nem chega aqui (recusado).
 */
export function eligibilityOf(inv: TreeInventoryExport, options: AnalyzeOptions, integrity: IntegrityAssessment): InventoryEligibility {
  const reasons: EligibilityReason[] = [];
  if (integrity.status === 'unsigned') reasons.push('integrity-unsigned');
  if (integrity.status !== 'authenticated' && integrity.status !== 'unsigned') reasons.push('integrity-unverifiable');
  if (!inv.verification || !inv.navigation) reasons.push('legacy-format');
  if (inv.status === 'partial') reasons.push('status-partial');
  if (inv.status === 'failed') reasons.push('status-failed');
  if (inv.abort) reasons.push('aborted');
  if (inv.resume?.mode === 'fast') reasons.push('fast-resume');
  if ((inv.resume?.reusedFolders ?? 0) > 0 || inv.verification?.contentRevalidated === false || inv.folders.some((f) => f.reusedFrom)) reasons.push('reused-folders');
  if ((inv.navigation?.contentChanged ?? 0) > 0 || inv.folders.some((f) => f.reasons.includes('content-changed'))) reasons.push('content-changed');
  if (inv.verification?.eligibleForPlanning !== true) reasons.push('not-eligible-for-planning');
  const age = options.now.getTime() - Date.parse(inv.finishedAt);
  const maxAgeDays = options.maxAgeDays ?? 7;
  if (!Number.isFinite(age) || age < 0 || !Number.isFinite(maxAgeDays) || maxAgeDays < 0 || age > maxAgeDays * 24 * 3600 * 1000) reasons.push('stale');
  const unique = [...new Set(reasons)];
  return unique.length === 0 ? { status: 'planning-eligible', reasons: [] } : { status: 'exploratory', reasons: unique };
}

const evidence = (f: FolderNode): FolderEvidence => ({
  ref: f.ref,
  ...(f.parentRef ? { parentRef: f.parentRef } : {}),
  depth: f.depth,
  status: f.status,
  ...(isRead(f) && !f.reusedFrom ? { counts: { items: f.counts.items, folders: f.counts.folders, files: f.counts.files } } : {}),
  ...(f.name !== undefined ? { name: f.name } : {}),
  ...(f.path !== undefined ? { path: f.path } : {}),
});

/** Subpastas de uma pasta lida, alinhadas às linhas de pasta da listagem dela. */
function childPairs(parent: FolderNode, kids: FolderNode[]): Array<{ name: string; node: FolderNode }> {
  const listed = parent.items.filter((i) => i.kind === 'folder');
  return listed.map((item, i) => ({ name: item.name, node: kids[i]! }));
}

export function analyzeStructure(input: unknown, options: AnalyzeOptions): StructuralReport {
  if (!(options.now instanceof Date) || !Number.isFinite(options.now.getTime())) throw new TypeError('A data de avaliação precisa ser válida.');
  const evaluatedAt = options.now.toISOString();
  // 1. estrutura; 2. integridade e procedência. Qualquer falha = recusado, sem achados.
  const problems = validateInventory(input);
  const integrity = verifyInventoryIntegrity(input, options.authenticator);
  if (integrity.status === 'invalid') problems.push(`integridade: ${INTEGRITY_MESSAGES[integrity.reason]}`);
  const inv = input as TreeInventoryExport;
  const source = problems.length
    ? {}
    : {
        runId: inv.runId,
        ...(inv.checkpointRunId ? { checkpointRunId: inv.checkpointRunId } : {}),
        finishedAt: inv.finishedAt,
        status: inv.status,
        ...(inv.resume ? { resumeMode: inv.resume.mode } : {}),
      };
  const empty = { findings: 0, byCategory: { 'possible-duplicate': 0, 'inconsistent-naming': 0, 'divergent-hierarchy': 0 }, byRule: {} };
  const base = { kind: 'air-organizer/structural-diagnostics' as const, schemaVersion: 2 as const, engineVersion: ENGINE_VERSION, identifiable: problems.length === 0, evaluatedAt, source, integrity };
  if (problems.length) {
    return { ...base, eligibility: { status: 'rejected', reasons: problems }, coverage: { folders: 0, foldersWithName: 0, foldersRead: 0, foldersComplete: 0 }, summary: empty, findings: [] };
  }

  const folders = [...inv.folders].sort(byRef);
  const refs = new Map(folders.map((f) => [f.ref, f]));
  const kidsOf = new Map<string, FolderNode[]>();
  for (const f of folders) if (f.parentRef) kidsOf.set(f.parentRef, [...(kidsOf.get(f.parentRef) ?? []), f]);
  // Pais com listagem própria nesta exportação (reaproveitadas da retomada rápida não têm itens).
  const listedParents = folders.filter((f) => isRead(f) && !f.reusedFrom);
  const findings: StructuralFinding[] = [];

  /* ── A. Possíveis duplicidades: pastas irmãs com nomes equivalentes ── */
  const siblingFindings = new Map<string, string>(); // ref -> id do achado A
  for (const parent of listedParents) {
    const groups = new Map<string, Array<{ name: string; node: FolderNode }>>();
    for (const pair of childPairs(parent, kidsOf.get(parent.ref) ?? [])) {
      const key = normalizeName(pair.name);
      if (key) groups.set(key, [...(groups.get(key) ?? []), pair]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const names = group.map((g) => g.name);
      const exact = new Set(names).size === 1;
      const rule: DiagnosticRule = exact ? 'DUP-SIBLING-EXACT' : 'DUP-SIBLING-NORMALIZED';
      const nodes = group.map((g) => g.node).sort(byRef);
      const unopened = nodes.filter((n) => !isRead(n)).length;
      const id = findingId(rule, nodes.map((n) => n.ref));
      for (const n of nodes) siblingFindings.set(n.ref, id);
      findings.push({
        id,
        category: 'possible-duplicate',
        rule,
        certainty: exact ? 'exact' : 'normalized',
        ...(exact ? {} : { matchedBy: requiredRules(names) }),
        summary: `${nodes.length} pastas irmãs com nomes ${exact ? 'idênticos' : 'equivalentes após normalização'}.`,
        folders: [evidence(parent), ...nodes.map(evidence)],
        measures: { pastas: nodes.length, naoAbertas: unopened },
        ...(exact ? {} : { names: { variants: [...new Set(names)].sort() } }),
        limitations: [
          'Nome equivalente não indica conteúdo igual; o conteúdo não foi comparado.',
          'Não indica que as pastas possam ser mescladas.',
          ...(unopened ? ['Há pastas não abertas pela leitura (homônimos exatos não são abertos na configuração padrão): contagens desconhecidas.'] : []),
          ...(parent.status === 'partial' ? ['A listagem do pai é parcial: pode haver outras irmãs equivalentes não lidas.'] : []),
        ],
        requiresHumanReview: true,
      });
    }
  }

  /* ── B. Nomenclatura inconsistente ── */
  type Occurrence = { name: string; node: FolderNode; parent: FolderNode };
  const occurrences: Occurrence[] = listedParents.flatMap((parent) => childPairs(parent, kidsOf.get(parent.ref) ?? []).map((p) => ({ ...p, parent })));
  const spellingGroups = new Map<string, Occurrence[]>();
  for (const o of occurrences) {
    const key = normalizeName(o.name, SPELLING_RULES);
    if (key) spellingGroups.set(key, [...(spellingGroups.get(key) ?? []), o]);
  }
  for (const group of spellingGroups.values()) {
    const variants = [...new Set(group.map((o) => o.name))].sort();
    const parents = new Set(group.map((o) => o.parent.ref));
    // Grafias diferentes só dentro de um mesmo pai já são o achado A (irmãs).
    if (variants.length < 2 || parents.size < 2) continue;
    const nodes = group.map((o) => o.node).sort(byRef);
    const id = findingId('NAME-VARIANTS', nodes.map((n) => n.ref));
    const related = [...new Set(nodes.map((n) => siblingFindings.get(n.ref)).filter((x): x is string => !!x))].sort();
    findings.push({
      id,
      category: 'inconsistent-naming',
      rule: 'NAME-VARIANTS',
      certainty: 'normalized',
      matchedBy: requiredRules(variants, SPELLING_RULES),
      summary: `O mesmo nome aparece com ${variants.length} grafias diferentes em ${parents.size} pastas pai.`,
      folders: nodes.map(evidence),
      measures: { grafias: variants.length, ocorrencias: nodes.length, pais: parents.size },
      names: { variants },
      ...(related.length ? { relatedFindings: related } : {}),
      limitations: ['Indica só diferença de grafia; não recomenda qual grafia adotar nem renomear nada.', 'Pastas com o mesmo nome em lugares diferentes podem ser legítimas.'],
      requiresHumanReview: true,
    });
  }
  for (const o of occurrences) {
    if (o.name === o.name.trim() && !/\s{2,}/.test(o.name)) continue;
    findings.push({
      id: findingId('NAME-SPACING', [o.node.ref]),
      category: 'inconsistent-naming',
      rule: 'NAME-SPACING',
      certainty: 'exact',
      summary: 'Nome com espaço no início, no fim ou repetido.',
      folders: [evidence(o.node)],
      limitations: ['A leitura do AIR normaliza espaços do texto exibido; esta regra só detecta o que chegou ao inventário.'],
      requiresHumanReview: true,
    });
  }

  /* ── C. Hierarquia divergente ── */
  for (const parent of listedParents) {
    if (parent.name === undefined) continue;
    for (const { name, node } of childPairs(parent, kidsOf.get(parent.ref) ?? [])) {
      if (normalizeName(name) !== normalizeName(parent.name)) continue;
      const exact = name === parent.name;
      findings.push({
        id: findingId('HIER-NESTED-SAME-NAME', [parent.ref, node.ref]),
        category: 'divergent-hierarchy',
        rule: 'HIER-NESTED-SAME-NAME',
        certainty: exact ? 'exact' : 'normalized',
        ...(exact ? {} : { matchedBy: requiredRules([name, parent.name]) }),
        summary: 'Subpasta com o mesmo nome da pasta que a contém.',
        folders: [evidence(parent), evidence(node)],
        limitations: ['Pode ser organização intencional; não indica erro nem recomenda mover.'],
        requiresHumanReview: true,
      });
    }
  }
  // Pastas equivalentes com listagem COMPLETA, em pais diferentes.
  const complete = folders.filter((f) => f.status === 'complete' && !f.reusedFrom && f.name !== undefined);
  const equivalents = new Map<string, FolderNode[]>();
  for (const f of complete) {
    const key = normalizeName(f.name!);
    if (key) equivalents.set(key, [...(equivalents.get(key) ?? []), f]);
  }
  const childSet = (f: FolderNode) => new Map(f.items.filter((i) => i.kind === 'folder').map((i) => [normalizeName(i.name), i.name] as const));
  for (const group of equivalents.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i]!, group[j]!];
        if (a.parentRef === b.parentRef) continue; // irmãs: categoria A
        const [ca, cb] = [childSet(a), childSet(b)];
        const common = [...ca.keys()].filter((k) => cb.has(k));
        const union = new Set([...ca.keys(), ...cb.keys()]);
        const onlyA = [...ca.keys()].filter((k) => !cb.has(k));
        const onlyB = [...cb.keys()].filter((k) => !ca.has(k));
        // Iguais não divergem; pouco em comum não indica padrão (estruturas legitimamente diferentes).
        if (onlyA.length + onlyB.length === 0 || common.length < MIN_COMMON_CHILDREN || common.length / union.size < MIN_JACCARD) continue;
        findings.push({
          id: findingId('HIER-EQUIVALENT-CHILDREN', [a.ref, b.ref]),
          category: 'divergent-hierarchy',
          rule: 'HIER-EQUIVALENT-CHILDREN',
          certainty: 'structural',
          summary: 'Pastas equivalentes em pais diferentes têm quase as mesmas subpastas, com algumas diferenças.',
          folders: [evidence(a), evidence(b)],
          measures: { emComum: common.length, soNaPrimeira: onlyA.length, soNaSegunda: onlyB.length, uniao: union.size },
          names: {
            common: common.map((k) => ca.get(k)!).sort(),
            onlyIn: { [a.ref]: onlyA.map((k) => ca.get(k)!).sort(), [b.ref]: onlyB.map((k) => cb.get(k)!).sort() },
          },
          limitations: [
            `Limiares: pelo menos ${MIN_COMMON_CHILDREN} subpastas em comum e sobreposição de pelo menos ${MIN_JACCARD * 100}% (Jaccard).`,
            'Setores e pastas diferentes podem ter hierarquias legitimamente diferentes; não indica erro.',
            'Compara só nomes de subpastas diretas, não o conteúdo.',
          ],
          requiresHumanReview: true,
        });
      }
    }
  }

  findings.sort(
    (x, y) =>
      CATEGORY_ORDER.indexOf(x.category) - CATEGORY_ORDER.indexOf(y.category) ||
      x.rule.localeCompare(y.rule) ||
      byRef(x.folders.at(-1)!, y.folders.at(-1)!) ||
      x.id.localeCompare(y.id),
  );
  const byCategory = { ...empty.byCategory };
  const byRule: Partial<Record<DiagnosticRule, number>> = {};
  for (const f of findings) {
    byCategory[f.category]++;
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  }
  return {
    ...base,
    completeness: {
      status: inv.status,
      ...(inv.verification ? { contentRevalidated: inv.verification.contentRevalidated } : {}),
      ...(inv.resume ? { resumeMode: inv.resume.mode } : {}),
    },
    eligibility: eligibilityOf(inv, options, integrity),
    coverage: {
      folders: folders.length,
      foldersWithName: folders.filter((f) => f.name !== undefined).length,
      foldersRead: folders.filter((f) => isRead(f) && !f.reusedFrom).length,
      foldersComplete: complete.length,
    },
    summary: { findings: findings.length, byCategory, byRule },
    findings,
  };
}

/** Versão sem dados identificáveis (padrão de console e de arquivo): sem nomes, caminhos nem grafias. */
export function redactReport(report: StructuralReport): StructuralReport {
  return {
    ...report,
    identifiable: false,
    source: {
      ...(report.source.finishedAt ? { finishedAt: report.source.finishedAt } : {}),
      ...(report.source.status ? { status: report.source.status } : {}),
      ...(report.source.resumeMode ? { resumeMode: report.source.resumeMode } : {}),
    },
    findings: report.findings.map(({ names: _names, ...f }) => ({
      ...f,
      folders: f.folders.map(({ name: _n, path: _p, ...e }) => e),
    })),
  };
}

/** Linha de console de um achado, sem dados identificáveis. */
export function formatFinding(f: StructuralFinding): string {
  const refs = f.folders.map((e) => e.ref).join(', ');
  const rules = f.matchedBy?.length ? ` [${f.matchedBy.join(', ')}]` : '';
  return `${f.id} ${f.rule} (${f.certainty}${rules}) ${f.summary} Pastas: ${refs}`;
}
