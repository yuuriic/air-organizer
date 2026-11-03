import path from 'node:path';
import type { AirEnvironment, Identified } from '../types/inventory.js';

export class SafetyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafetyViolation';
  }
}

/**
 * Únicas ações de UI permitidas na POC-01. Não existe ação genérica de clique:
 * qualquer nova ação precisa ser adicionada aqui explicitamente.
 */
export type ReadOnlyAction = 'pagination-next' | 'pagination-page';

/** Termos que indicam ação de escrita, seleção ou exportação de conteúdo. */
const FORBIDDEN_LABEL =
  /mover|move|excluir|exclus|delete|apagar|remov|editar|edit|renomear|rename|criar|create|nov[oa]\b|upload|enviar|anexar|select|selecion|download|baixar|compartilh|share|arquivar|restaurar|salvar|save|confirm/i;

/** Rótulos textuais aceitos para o botão de próxima página. No AIR real o botão só tem ícone. */
export const NEXT_PAGE_LABEL = /^(pr[oó]xim[ao]( p[aá]gina)?|ir para a pr[oó]xima p[aá]gina|next( page)?|go to next page|›|»|>)$/i;

/** Rótulo sintético do botão de próxima página identificado só pelo ícone (sem texto/aria-label). */
export const NEXT_PAGE_ICON_LABEL = 'icon:chevron-right';

const ALLOWED_LABEL: Record<ReadOnlyAction, RegExp> = {
  'pagination-next': new RegExp(`${NEXT_PAGE_LABEL.source}|^${NEXT_PAGE_ICON_LABEL}$`, 'i'),
  // Botão numérico do paginador: o rótulo é só o número da página.
  'pagination-page': /^[1-9]\d{0,4}$/,
};

/**
 * Lança SafetyViolation se o rótulo do controle não corresponder exatamente à ação
 * read-only declarada, ou se contiver qualquer termo de escrita/seleção.
 */
export function assertReadOnlyAction(action: ReadOnlyAction, label: string): void {
  const normalized = label.replace(/\s+/g, ' ').trim();
  if (FORBIDDEN_LABEL.test(normalized)) {
    throw new SafetyViolation(`Controle "${normalized}" bloqueado: rótulo indica ação não permitida.`);
  }
  if (!ALLOWED_LABEL[action].test(normalized)) {
    throw new SafetyViolation(`Controle "${normalized}" não corresponde à ação read-only "${action}".`);
  }
}

export function assertReadOnlyMode(readOnly: boolean): asserts readOnly is true {
  if (readOnly !== true) {
    throw new SafetyViolation('A POC-01 só pode ser executada em modo somente leitura.');
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Remove query string e fragmento (podem conter tokens) e valida o protocolo.
 * HTTP só é aceito para hosts locais quando explicitamente permitido (fixtures).
 */
export function sanitizeUrl(rawUrl: string, options: { allowInsecureLocal?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafetyViolation('URL inválida.');
  }
  const insecureLocalOk = options.allowInsecureLocal === true && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !insecureLocalOk) {
    throw new SafetyViolation(`Protocolo não permitido (${url.protocol}). Use uma instância AIR em HTTPS.`);
  }
  if (url.username || url.password) {
    throw new SafetyViolation('URLs com credenciais embutidas não são aceitas.');
  }
  url.search = '';
  url.hash = '';
  return url;
}

/** Impressão digital do escopo: origem + URL + pasta + breadcrumb + setor. Deve permanecer igual durante a análise. */
export type ScopeFingerprint = {
  instanceOrigin?: string;
  pageUrl?: string;
  currentFolder?: string;
  sector?: string;
  breadcrumb?: string[];
};

function valueOf<T>(field: Identified<T>): T | undefined {
  return field.status === 'identified' ? field.value : undefined;
}

export function fingerprintOf(env: AirEnvironment): ScopeFingerprint {
  return {
    instanceOrigin: valueOf(env.instanceOrigin),
    pageUrl: valueOf(env.pageUrl),
    currentFolder: valueOf(env.currentFolder),
    sector: valueOf(env.sector),
    breadcrumb: valueOf(env.breadcrumb),
  };
}

/** Pré-condições para iniciar uma análise. Retorna a lista de bloqueios (vazia = ok). */
export function validateAnalysisScope(env: AirEnvironment): string[] {
  const problems: string[] = [];
  if (env.instanceOrigin.status !== 'identified') {
    problems.push(`Origem da instância não identificada: ${env.instanceOrigin.reason}`);
  }
  if (env.currentFolder.status !== 'identified' && env.breadcrumb.status !== 'identified') {
    problems.push('Pasta atual não identificada (sem breadcrumb). A análise não pode ser vinculada a um caminho.');
  }
  return problems;
}

/** Compara o escopo atual com o inicial. Qualquer diferença interrompe a análise. */
export function compareScope(baseline: ScopeFingerprint, current: ScopeFingerprint): string[] {
  const problems: string[] = [];
  if (baseline.instanceOrigin !== current.instanceOrigin) {
    problems.push(`Origem mudou de "${baseline.instanceOrigin ?? '?'}" para "${current.instanceOrigin ?? '?'}".`);
  }
  if (baseline.pageUrl !== current.pageUrl) {
    problems.push(`URL da pasta mudou de "${baseline.pageUrl ?? '?'}" para "${current.pageUrl ?? '?'}".`);
  }
  if (baseline.currentFolder !== current.currentFolder) {
    problems.push(`Pasta atual mudou de "${baseline.currentFolder ?? '?'}" para "${current.currentFolder ?? '?'}".`);
  }
  if (baseline.sector !== undefined && baseline.sector !== current.sector) {
    problems.push(`Setor mudou de "${baseline.sector}" para "${current.sector ?? '?'}".`);
  }
  const before = (baseline.breadcrumb ?? []).join(' / ');
  const after = (current.breadcrumb ?? []).join(' / ');
  if (before !== after) {
    problems.push(`Breadcrumb mudou de "${before}" para "${after}".`);
  }
  return problems;
}

/** Garante que `target` fique dentro de `baseDir` (sem travessia de diretórios). */
export function assertInsideDirectory(baseDir: string, target: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, target);
  const relative = path.relative(base, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SafetyViolation(`Caminho de saída fora do diretório permitido: ${target}`);
  }
  return resolved;
}

/** Checkpoints e a chave local nunca ficam dentro do repositório (padrão: diretório atual). */
export function assertOutsideRepository(paths: readonly string[], repositoryDir = process.cwd()): void {
  const repo = path.resolve(repositoryDir);
  for (const p of paths.map((x) => path.resolve(x))) {
    if (p === repo || p.startsWith(repo + path.sep)) {
      throw new SafetyViolation('Checkpoints e a chave local não podem ficar dentro do repositório. Configure AIR_ORGANIZER_CHECKPOINT_DIR fora dele.');
    }
  }
}

/** Motivo, sem nomes, de uma abertura de subpasta recusada ANTES do clique. */
export type OpenRefusalCode = 'not-folder' | 'row-changed' | 'homonym' | 'interactive-cell' | 'precondition';

/** Abertura recusada antes do clique: a pasta exibida continua a mesma. `code` é seguro para logs. */
export class OpenRefusedError extends SafetyViolation {
  constructor(
    readonly code: OpenRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpenRefusedError';
  }
}

/** Fatos observados imediatamente antes de abrir uma subpasta. */
export type FolderOpenTarget = {
  expectedName: string;
  rowName: string;
  cellText: string;
  kind: 'folder' | 'file' | 'unknown';
  /** Linhas da página com o mesmo nome (homônimos impedem confirmar a identidade). */
  sameNameRows: number;
  /** Controles interativos dentro da célula do nome (o clique deve cair só no texto). */
  interactiveInCell: number;
};

/**
 * Abrir subpasta é a única navegação por linha permitida. No AIR, clicar numa linha de
 * ARQUIVO abre um visualizador editável: só linhas comprovadamente de pasta são aceitas.
 * O nome da pasta é dado, não rótulo de controle: a blocklist de rótulos não se aplica a ele.
 */
export function assertFolderOpenTarget(target: FolderOpenTarget): void {
  if (target.kind !== 'folder') {
    throw new OpenRefusedError('not-folder', `"${target.expectedName}" não é comprovadamente uma pasta (tipo: ${target.kind}); clique recusado.`);
  }
  if (target.rowName !== target.expectedName || target.cellText !== target.expectedName) {
    throw new OpenRefusedError('row-changed', `A linha exibida ("${target.cellText}") não é a subpasta escolhida ("${target.expectedName}").`);
  }
  if (target.sameNameRows !== 1) {
    throw new OpenRefusedError('homonym', `Há ${target.sameNameRows} itens chamados "${target.expectedName}" nesta página; identidade ambígua.`);
  }
  if (target.interactiveInCell !== 0) {
    throw new OpenRefusedError('interactive-cell', 'A célula do nome contém controles interativos; clique recusado.');
  }
}

/** Fatos observados no breadcrumb antes de voltar à pasta pai. */
export type ParentLinkTarget = {
  expectedParent: string;
  expectedCurrent: string;
  currentText: string;
  currentIsCurrentPage: boolean;
  linkCount: number;
  linkText: string;
};

export function assertParentLinkTarget(target: ParentLinkTarget): void {
  if (!target.currentIsCurrentPage || target.currentText !== target.expectedCurrent) {
    throw new SafetyViolation(`O último item do breadcrumb ("${target.currentText}") não é a pasta atual ("${target.expectedCurrent}").`);
  }
  if (target.linkCount !== 1 || target.linkText !== target.expectedParent) {
    throw new SafetyViolation(`O item anterior do breadcrumb ("${target.linkText}") não é um link único para a pasta pai ("${target.expectedParent}").`);
  }
}
