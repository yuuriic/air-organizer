/**
 * Contratos da POC-01. Nenhum tipo aqui carrega conteúdo de documento,
 * credencial, cookie ou token — apenas metadados visíveis na listagem do AIR.
 */

/** Valor que pode não ter sido identificado com segurança. Nunca inventar. */
export type Identified<T> =
  | { status: 'identified'; value: T; source: IdentificationSource }
  | { status: 'not-identified'; reason: string };

export type IdentificationSource = 'url' | 'breadcrumb' | 'page-heading' | 'operator';

export type AirEnvironment = {
  /** Origem HTTPS sem path, query ou fragmento (ex.: https://air.exemplo.test). */
  instanceOrigin: Identified<string>;
  /** URL sem query string nem fragmento, para não registrar tokens. */
  pageUrl: Identified<string>;
  client: Identified<string>;
  sector: Identified<string>;
  currentFolder: Identified<string>;
  /** Segmentos do breadcrumb, na ordem exibida. */
  breadcrumb: Identified<string[]>;
  observedAt: string;
};

/** 'unknown' quando a UI não permite distinguir pasta de arquivo com segurança. */
export type ItemKind = 'folder' | 'file' | 'unknown';

export type IdentityConfidence = 'stable-id' | 'path-and-metadata' | 'ambiguous';

/** Linha bruta extraída do DOM: cabeçalho → texto da célula. */
export type RawRow = {
  cells: Record<string, string>;
  /** Pistas visuais de tipo (ícone, aria-label, classe) sem interpretação. */
  kindHints: string[];
  /** Atributos candidatos a ID (data-id, data-row-id...), sem interpretação. */
  idCandidates: Record<string, string>;
  /** Ícone da coluna de tipo: "folder" (svg lucide) ou "img:pdf icon" (<img alt>); "" = nenhum/ambíguo. Ausente sem a coluna. */
  typeIcon?: string;
};

export type AirItem = {
  /** Somente se um ID estável for comprovadamente observado na UI. */
  id?: string;
  kind: ItemKind;
  /** De onde veio o tipo (ex.: "icon:folder"); ausente quando kind = 'unknown'. */
  kindEvidence?: string;
  name: string;
  description?: string;
  /** Caminho conforme exibido pela coluna "Caminho", quando existir. */
  path?: string;
  createdAt?: string;
  status?: string;
  sourcePage: number;
  rowIndex: number;
  observedAt: string;
  identityConfidence: IdentityConfidence;
  /** Assinatura contextual usada para deduplicar observações (não é ID do AIR). */
  observationKey: string;
};

export type PageSnapshot = {
  rows: RawRow[];
  /** Indicador textual da página, se exibido (ex.: "Página 2 de 5"). */
  pageIndicator?: string;
  /** Total de itens da pasta exibido no título ("Nome (N)"), se exibido. */
  reportedTotal?: number;
  /** N de "X de N linhas(s) selecionadas": linhas da página atual, NÃO da pasta. */
  pageRowCounter?: number;
  /** Rótulo do filtro de tipo acima da tabela (só "Todos" mostra a pasta inteira). */
  typeFilter?: string;
  /** Busca acima da tabela preenchida: a listagem está filtrada. */
  searchActive?: boolean;
};

export type PageReadResult = {
  pageNumber: number;
  signature: string;
  rowCount: number;
  pageIndicator?: string;
};

export type ScanIssueKind =
  | 'page-unchanged'
  | 'loop-detected'
  | 'timeout'
  | 'read-error'
  | 'navigation-error'
  | 'max-pages-reached'
  | 'max-items-reached'
  | 'scope-changed'
  | 'parse-warning'
  | 'count-mismatch'
  | 'filter-active'
  /** A página ativa no paginador não é a página que o scanner esperava ler. */
  | 'page-mismatch'
  /** Parada pedida pelo operador antes do fim da listagem: há páginas não lidas. */
  | 'stopped';

export type ScanIssue = {
  kind: ScanIssueKind;
  pageNumber?: number;
  message: string;
};

export type CoverageReport = {
  pagesRead: number;
  /** Estimado a partir de total/tamanho de página, se possível. */
  expectedPages?: number;
  itemsObserved: number;
  uniqueItems: number;
  repeatedObservations: number;
  reportedTotal?: number;
  /** Páginas que se sabe existirem e não foram lidas (quando estimável). */
  unreadPages: number[];
  complete: boolean;
  stopReason: 'last-page' | 'error' | 'loop' | 'timeout' | 'max-pages' | 'max-items' | 'scope-changed' | 'stopped';
  issues: ScanIssue[];
};

export type ScanResult = {
  items: AirItem[];
  pages: PageReadResult[];
  coverage: CoverageReport;
};

export type DuplicateConfidence = 'high' | 'medium';

export type DuplicateSuspicion = {
  suspicionId: string;
  normalizedName: string;
  /** Regras de normalização que tornaram os nomes equivalentes. */
  matchedBy: NormalizationRule[];
  confidence: DuplicateConfidence;
  items: Array<Pick<AirItem, 'name' | 'kind' | 'path' | 'createdAt' | 'observationKey'>>;
  /** Sempre suspeita: nomes iguais não provam conteúdo igual. */
  classification: 'suspected-duplicate';
  requiresHumanReview: true;
};

export type NormalizationRule = 'case' | 'diacritics' | 'whitespace' | 'punctuation';

export type Inventory = {
  schemaVersion: 1;
  tool: 'air-organizer';
  runId: string;
  mode: 'current-folder';
  readOnly: true;
  environment: AirEnvironment;
  startedAt: string;
  finishedAt: string;
  coverage: CoverageReport;
  items: AirItem[];
  duplicateSuspicions: DuplicateSuspicion[];
};

/* ───────────── Leitura recursiva controlada (POC-01D) ───────────── */

/** Limites obrigatórios de uma leitura recursiva. Nunca são aumentados automaticamente. */
export type TreeLimits = {
  /** Profundidade máxima a partir da pasta inicial (0 = só a pasta inicial). */
  maxDepth: number;
  /** Pastas lidas no total, incluindo a inicial. */
  maxFolders: number;
  /** Itens lidos no total (verificado ao fim de cada página). */
  maxItems: number;
  maxPagesPerFolder: number;
};

export type FolderStatus = 'complete' | 'partial' | 'failed' | 'skipped';

/** Motivos de pendência. Códigos sem nomes: seguros para logs e relatórios diagnósticos. */
export type PendingReason =
  | 'max-depth'
  | 'max-folders'
  | 'max-items'
  | 'max-pages'
  | 'read-incomplete'
  | 'read-error'
  | 'unknown-items'
  | 'homonym'
  /** Item listado na pasta com "Caminho" de outro ramo: não é aberto (pode estar fora do escopo). */
  | 'location-mismatch'
  | 'open-refused'
  | 'cycle'
  | 'repeated-visit'
  | 'navigation-lost'
  | 'return-failed'
  | 'run-aborted'
  /**
   * ADR-013: a volta confirmou a identidade da pasta, mas o total ou a listagem divergiram do
   * lido antes. Divergência OBSERVADA, não sua causa. A pasta e os ancestrais deixam de ser
   * completos, e as subpastas ainda não abertas não são abertas a partir da listagem antiga.
   */
  | 'content-changed';

export type FolderNode = {
  /** Referência sequencial da execução (F1 = pasta inicial). Não é ID do AIR. */
  ref: string;
  parentRef?: string;
  depth: number;
  /** Resultado da leitura da PRÓPRIA pasta (listagem de filhos diretos). */
  status: FolderStatus;
  /** Resultado da pasta e de todos os descendentes dentro do escopo. */
  subtreeStatus: FolderStatus;
  reasons: PendingReason[];
  /** Código da recusa antes do clique, quando reasons inclui 'open-refused'. */
  refusal?: string;
  counts: { items: number; folders: number; files: number; unknown: number; locationMismatch: number; pagesRead: number; unreadPages: number[] };
  issueKinds: ScanIssueKind[];
  /**
   * Subárvore reaproveitada de um checkpoint (não reaberta nesta sessão): data da observação
   * original. Ver ARCHITECTURE.md §7.7.
   */
  reusedFrom?: string;
  /**
   * Comparação com o checkpoint, em execuções retomadas: 'unchanged'/'changed' = relida nesta
   * sessão e comparada (total, páginas, itens); 'new' = sem registro; 'reused' = NÃO relida.
   */
  verification?: 'unchanged' | 'changed' | 'new' | 'reused';
  /* ── Campos identificáveis: só saem no inventário detalhado, com confirmação. ── */
  /** Ausente em descendentes reaproveitados de checkpoint (o checkpoint não guarda nomes). */
  name?: string;
  path?: string;
  pageUrl?: string;
  items: AirItem[];
  /** Mensagens de diagnóstico (podem conter nomes). */
  diagnostics: string[];
};

export type TreeTotals = {
  foldersRead: number;
  foldersPending: number;
  items: number;
  folders: number;
  files: number;
  unknown: number;
  pagesRead: number;
};

export type TreeResult = {
  status: 'complete' | 'partial' | 'failed';
  limits: TreeLimits;
  /** Interrupção da execução inteira (navegação incerta): nenhum clique depois disso. */
  abort?: { reason: 'navigation-lost' | 'return-failed'; atRef: string; message: string; diagnostic?: NavigationDiagnostic };
  /** Parada controlada pedida pelo operador deixou algo sem ler (sem clique pendente nem navegação incerta). */
  stopped?: true;
  limitsReached: Array<'max-depth' | 'max-folders' | 'max-items' | 'max-pages'>;
  folders: FolderNode[];
  totals: TreeTotals;
  /** Presente em execuções retomadas: modo, reaproveitamento e comparação com o checkpoint. */
  resume?: {
    mode: ResumeMode;
    reusedFolders: number;
    oldestReusedObservation?: string;
    /** Pastas relidas nesta sessão, comparadas com o registro do checkpoint. */
    unchanged: number;
    changed: number;
    /** Pastas sem registro no checkpoint. */
    new: number;
    /** Subpastas registradas que não aparecem mais na listagem relida do pai. */
    removed: number;
  };
  /**
   * Toda pasta contada foi lida NESTA sessão? Só então o resultado completo pode servir de base
   * para planejar movimentações (POC-02). Nenhum modo garante consistência transacional: o AIR
   * pode mudar durante a própria leitura.
   */
  verification: { contentRevalidated: boolean; eligibleForPlanning: boolean };
  /**
   * Diagnósticos de navegação separados (ADR-013), sem dados identificáveis: pastas com conteúdo
   * divergente na volta, e a categoria da interrupção, se houve.
   */
  navigation: { contentChanged: number; identityMismatch: number; navigationFailed: number };
};

/**
 * 'fast': reaproveita subárvores assentadas (conteúdo interno NÃO revalidado).
 * 'verified': relê todo o escopo e compara com o checkpoint.
 */
export type ResumeMode = 'fast' | 'verified';

/**
 * Conteúdo de `tree-inventory.json` (opções 6/7, exportado só com confirmação): o TreeResult com
 * os metadados da sessão. IDENTIFICÁVEL. Entrada do diagnóstico estrutural (POC-02A).
 * Exportações anteriores à POC-01E não têm `verification`, `navigation` nem `resume`; anteriores à
 * POC-02B.1 não têm `integrity` (legadas: só exploratórias).
 */
export type TreeInventoryExport = Omit<TreeResult, 'verification' | 'navigation'> &
  Partial<Pick<TreeResult, 'verification' | 'navigation'>> & {
    schemaVersion: 2;
    tool: 'air-organizer';
    mode: 'recursive';
    readOnly: true;
    identifiable: true;
    runId: string;
    checkpointRunId?: string;
    startedAt: string;
    finishedAt: string;
    environment: AirEnvironment;
    integrity?: InventorySeal;
  };

/**
 * Selo de integridade e procedência local do `tree-inventory.json` (POC-02B.1, ARCHITECTURE.md §8.5).
 * `mac` = HMAC-SHA256, com subchave derivada por HKDF-SHA256 da chave local, sobre o JSON canônico
 * do documento inteiro (exceto `integrity`) e deste cabeçalho (exceto `mac`).
 *
 * Prova só que o arquivo foi gravado por esta instalação e não mudou desde então. NÃO prova que o
 * AIR ainda está como na leitura, e NÃO autoriza nenhuma movimentação.
 */
export type InventorySeal = {
  format: 'air-organizer/tree-inventory-seal';
  version: 1;
  algorithm: 'HMAC-SHA256';
  keyDerivation: 'HKDF-SHA256';
  canonicalization: 'canonical-json-v1';
  coverage: 'document-except-integrity';
  /** Identificador público da subchave (derivado; não revela a chave). */
  keyId: string;
  sealedAt: string;
  /** Hex, 64 caracteres. */
  mac: string;
};

/**
 * Por que a navegação foi dada como perdida, sem dados identificáveis: código da verificação que
 * falhou e, numa espera esgotada, o resultado de cada condição e as leituras que falharam.
 */
export type NavigationDiagnostic = {
  /** 'identity-mismatch' (lida e não é a esperada) ou 'navigation-failed' (não confirmável). */
  category?: 'identity-mismatch' | 'navigation-failed';
  code: string;
  checks?: { observations: number; conditions?: Record<string, boolean>; readFailures: Partial<Record<string, number>>; unstable: number };
};

/** Progresso acumulado da execução (sem dados identificáveis). */
export type TreeProgress = { foldersRead: number; items: number; pages: number; pending: number };

/** Evento de progresso. Nunca contém nomes, caminhos ou URLs. */
export type TreeEvent = {
  type: 'folder-read' | 'folder-pending' | 'folder-reused' | 'limit-reached' | 'aborted' | 'progress';
  ref: string;
  depth: number;
  status?: FolderStatus;
  reasons?: PendingReason[];
  items?: number;
  pages?: number;
  /** Só em 'folder-reused': pastas da subárvore reaproveitada. */
  folders?: number;
  /** Só em 'progress'. */
  progress?: TreeProgress;
};
