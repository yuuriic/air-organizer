import { createHash } from 'node:crypto';
import type { IntegrityAssessment, InventoryAuthenticator } from './inventory-integrity.js';
import {
  ENGINE_VERSION,
  analyzeStructure,
  type Certainty,
  type DiagnosticRule,
  type FolderEvidence,
  type InventoryEligibility,
  type StructuralFinding,
  type StructuralReport,
} from './structural-diagnostics.js';
import type { NormalizationRule, TreeInventoryExport } from '../types/inventory.js';

/**
 * Planejamento de organização (POC-02B.2). Motor DETERMINÍSTICO, local e somente leitura: sem
 * navegador, sem sistema de arquivos, sem rede. Transforma um inventário autenticado e elegível em
 * PROPOSTAS DE REVISÃO para uma pessoa avaliar.
 *
 * - Nenhuma proposta é executável nem autoriza mover, excluir, mesclar ou renomear nada no AIR.
 *   O formato não tem operações, comandos, destinos nem URLs (ver ARCHITECTURE.md §9.1).
 * - Na geração, o selo, a estrutura, a completude e a idade são conferidos DE NOVO (via
 *   `analyzeStructure` e uma checagem própria da completude, que não confia nas flags gravadas).
 *   Qualquer dúvida = plano recusado, sem propostas.
 * - Mesmo nome nunca é tratado como conteúdo equivalente.
 * - O plano NÃO é autenticado nesta etapa: não serve de fonte confiável para uma execução futura
 *   sem nova leitura e revalidação.
 *
 * Mesmo inventário + mesmo `now` = mesmo plano, byte a byte.
 */

export const PLAN_FORMAT = 'air-organizer/organization-plan';
export const PLANNER_VERSION = '1';

export type ProposalKind = 'review-equivalent-names' | 'review-naming-inconsistency' | 'review-divergent-hierarchy' | 'review-standardization';

/**
 * Força da EVIDÊNCIA ESTRUTURAL que motivou a proposta (critério em `basis`). Não é probabilidade,
 * não diz que existe um problema e nunca é autorização operacional.
 */
export type EvidenceConfidence = { level: 'high' | 'medium' | 'low'; basis: string };

/** Hipótese para uma revisão futura. Nunca executável; sem origem/destino operacional. */
export type FutureAction = {
  kind: 'consolidation-review' | 'name-standardization-review';
  executable: false;
  authorizesChanges: false;
  /** Sem nomes. */
  hypothesis: string;
  preconditions: string[];
  /** Grafia hipotética da padronização — só no plano detalhado (identificável). */
  hypothesisName?: string;
};

export type PlanProposal = {
  /** Estável para o mesmo inventário autenticado: versão, identidade do inventário, tipo e achados. */
  id: string;
  kind: ProposalKind;
  status: 'pending-review';
  executable: false;
  /** 1. Diagnóstico observado (do motor estrutural). */
  observed: {
    findingIds: string[];
    rules: DiagnosticRule[];
    certainty: Certainty;
    matchedBy?: NormalizationRule[];
    measures?: Record<string, number>;
    folders: FolderEvidence[];
    /** Grafias e subpastas — só no plano detalhado. */
    names?: StructuralFinding['names'];
    relatedFindings?: string[];
  };
  /** 2. Proposta de revisão (sem nomes). */
  proposal: { summary: string; justification: string; reviewQuestions: string[] };
  /** 3. Possível ação futura, só quando há evidência suficiente; nunca executável. */
  futureAction?: FutureAction;
  confidence: EvidenceConfidence;
  /** 4. Impedimentos e riscos. */
  blockers: string[];
  risks: string[];
};

export type PlanValidation = {
  status: 'accepted' | 'refused';
  integrity: IntegrityAssessment;
  completeness?: StructuralReport['completeness'];
  /** Elegibilidade recalculada agora (não lida de um relatório gravado). */
  eligibility: InventoryEligibility;
  /** Problemas da checagem própria de completude (independente das flags do inventário). */
  basisProblems: string[];
  maxAgeDays: number;
  /** Motivos da recusa, sem nomes, caminhos nem códigos do selo. */
  reasons: string[];
};

export type OrganizationPlan = {
  kind: typeof PLAN_FORMAT;
  schemaVersion: 1;
  plannerVersion: string;
  engineVersion: string;
  identifiable: boolean;
  generatedAt: string;
  executable: false;
  authorizesChanges: false;
  /** O próprio plano não tem selo nesta etapa. */
  authenticated: false;
  notices: string[];
  source: {
    runId?: string;
    checkpointRunId?: string;
    finishedAt?: string;
    sealedAt?: string;
    /** Identidade do inventário autenticado: hash do código do selo (não o expõe). */
    inventoryId?: string;
  };
  validation: PlanValidation;
  /** Ausente em plano recusado. */
  observed?: { coverage: StructuralReport['coverage']; findings: number; byRule: StructuralReport['summary']['byRule'] };
  summary: { proposals: number; byKind: Record<ProposalKind, number>; withFutureAction: number; withBlockers: number };
  proposals: PlanProposal[];
};

export type PlanOptions = { now: Date; maxAgeDays?: number; authenticator?: InventoryAuthenticator };

const KIND_ORDER: ProposalKind[] = ['review-equivalent-names', 'review-naming-inconsistency', 'review-standardization', 'review-divergent-hierarchy'];

export const PLAN_NOTICES = [
  'Propostas para revisão humana: nenhuma é executável nem autoriza mover, excluir, mesclar ou renomear nada no AIR.',
  'Confiança = força da evidência estrutural observada; não é probabilidade nem autorização.',
  'Mesmo nome não indica conteúdo equivalente: o conteúdo das pastas não foi comparado.',
  'Este plano não é autenticado: não use como fonte para uma execução futura sem nova leitura e revalidação.',
  'O AIR pode ter mudado desde a leitura.',
];

const COMMON_RISKS = ['O AIR pode ter mudado desde a leitura; qualquer ação exige nova leitura VERIFICADA.'];
const SECTOR_PRECONDITION = 'Ação restrita ao setor desta leitura; nunca entre setores.';
const SECTOR_BLOCKER = 'Setor não identificado na leitura: nenhuma ação futura pode ser considerada.';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Identidade do inventário autenticado: hash com separação de domínio do código do selo. */
export function inventoryIdentity(mac: string): string {
  return sha(`${PLAN_FORMAT}/inventory-id\u0000${mac}`).slice(0, 16);
}

function proposalId(inventoryId: string, kind: ProposalKind, findingIds: string[]): string {
  return `P-${sha(`${PLAN_FORMAT}/v${PLANNER_VERSION}|${inventoryId}|${kind}|${[...findingIds].sort().join(',')}`).slice(0, 16)}`;
}

/**
 * Completude conferida a partir das PASTAS, sem confiar em `verification`/`status` gravados.
 * Só nomes de regras e contagens: nada identificável.
 */
export function planningBasisProblems(inv: TreeInventoryExport): string[] {
  const problems: string[] = [];
  if (inv.status !== 'complete') problems.push('leitura não está completa');
  if (inv.abort) problems.push('leitura interrompida');
  if (!Array.isArray(inv.limitsReached) || inv.limitsReached.length > 0) problems.push('limites da leitura atingidos ou não informados');
  if (!inv.verification || inv.verification.contentRevalidated !== true || inv.verification.eligibleForPlanning !== true) problems.push('verificação da leitura não confirma revalidação completa');
  if (!inv.navigation || inv.navigation.contentChanged !== 0) problems.push('divergência de conteúdo observada na navegação (ou formato antigo)');
  if (inv.resume && (inv.resume.mode !== 'verified' || inv.resume.reusedFolders !== 0)) problems.push('retomada não VERIFICADA ou com pastas reaproveitadas');
  const count = (pred: (f: TreeInventoryExport['folders'][number]) => boolean) => inv.folders.filter(pred).length;
  const incomplete = count((f) => f.status !== 'complete' || f.subtreeStatus !== 'complete');
  const reused = count((f) => f.reusedFrom !== undefined || f.verification === 'reused');
  const pending = count((f) => f.reasons.length > 0);
  if (inv.folders.length === 0) problems.push('inventário sem pastas');
  if (incomplete) problems.push(`${incomplete} pasta(s) sem leitura completa`);
  if (reused) problems.push(`${reused} pasta(s) reaproveitada(s) sem releitura`);
  if (pending) problems.push(`${pending} pasta(s) com pendência`);
  return problems;
}

const emptyByKind = (): Record<ProposalKind, number> => ({ 'review-equivalent-names': 0, 'review-naming-inconsistency': 0, 'review-standardization': 0, 'review-divergent-hierarchy': 0 });

type Draft = Omit<PlanProposal, 'id' | 'status' | 'executable' | 'observed'>;

/** Grafia com maioria ESTRITA entre as ocorrências; sem maioria, nenhuma hipótese. */
function predominantSpelling(folders: FolderEvidence[]): { name: string; count: number; total: number } | undefined {
  const names = folders.map((f) => f.name).filter((n): n is string => n !== undefined);
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return best && best[1] * 2 > names.length ? { name: best[0], count: best[1], total: names.length } : undefined;
}

function draftFor(f: StructuralFinding, sectorIdentified: boolean): Draft {
  const rulesText = f.matchedBy?.length ? ` (regras: ${f.matchedBy.join(', ')})` : '';
  switch (f.rule) {
    case 'DUP-SIBLING-EXACT':
    case 'DUP-SIBLING-NORMALIZED': {
      const exact = f.rule === 'DUP-SIBLING-EXACT';
      const n = f.measures?.pastas ?? f.folders.length - 1;
      const unopened = f.measures?.naoAbertas ?? 0;
      const blockers = ['O conteúdo das pastas não foi comparado; nome equivalente não indica conteúdo equivalente.'];
      if (unopened) blockers.push(`${unopened} pasta(s) não aberta(s) pela leitura (homônimos exatos não são abertos na configuração padrão): conteúdo e contagens desconhecidos.`);
      if (f.folders[0]?.status !== 'complete') blockers.push('A listagem do pai não está completa.');
      if (!sectorIdentified) blockers.push(SECTOR_BLOCKER);
      const enough = unopened === 0 && sectorIdentified && f.folders[0]?.status === 'complete';
      return {
        kind: 'review-equivalent-names',
        proposal: {
          summary: `Revisar ${n} pastas irmãs com nomes ${exact ? 'idênticos' : `equivalentes após normalização${rulesText}`}.`,
          justification: 'Pastas no mesmo pai com nomes equivalentes dificultam localizar documentos e podem indicar duplicação de estrutura.',
          reviewQuestions: [
            'As pastas tratam do mesmo assunto ou de contextos diferentes?',
            'A estrutura, os nomes e o contexto confirmam que são a mesma categoria?',
            'Se houver consolidação, qual pasta seria a principal (escolha explícita do revisor)?',
          ],
        },
        ...(enough
          ? {
              futureAction: {
                kind: 'consolidation-review' as const,
                executable: false as const,
                authorizesChanges: false as const,
                hypothesis: 'Avaliar, em revisão humana, se o conteúdo pode ser reunido numa das pastas, escolhida explicitamente pelo revisor.',
                preconditions: [
                  'Confirmação, por uma pessoa, de que as pastas representam a mesma categoria, pela estrutura, pelos nomes e pelo contexto.',
                  'Escolha explícita da pasta principal; o plano não indica origem nem destino.',
                  'Plano de conflitos para subpastas homônimas internas (§8.3).',
                  'Nova leitura VERIFICADA, autenticada e recente antes de qualquer ação.',
                  SECTOR_PRECONDITION,
                ],
              },
            }
          : {}),
        confidence: exact
          ? { level: 'high', basis: 'Nomes textualmente idênticos no mesmo pai.' }
          : f.matchedBy?.includes('punctuation')
            ? { level: 'low', basis: 'Nomes equivalentes só ao ignorar pontuação, que pode mudar o sentido.' }
            : { level: 'medium', basis: 'Nomes equivalentes por caixa, acento ou espaços, no mesmo pai.' },
        blockers,
        risks: ['Consolidar pastas pode misturar documentos de contextos diferentes.', ...COMMON_RISKS],
      };
    }
    case 'NAME-VARIANTS': {
      const top = predominantSpelling(f.folders);
      const proposal = {
        summary: `Revisar ${f.measures?.grafias ?? 0} grafias do mesmo nome em ${f.measures?.pais ?? 0} pastas pai${rulesText}.`,
        justification: 'Grafias diferentes do mesmo nome dificultam a busca e a padronização.',
        reviewQuestions: ['As ocorrências se referem ao mesmo assunto?', 'Existe um padrão oficial de nomenclatura no setor?'],
      };
      const confidence: EvidenceConfidence = { level: 'medium', basis: 'Grafias equivalentes por caixa, acento ou espaços em pais diferentes.' };
      const risks = ['Pastas com o mesmo nome em lugares diferentes podem ser legítimas.', 'Renomear pode afetar quem procura pelo nome atual.', ...COMMON_RISKS];
      if (!top || !sectorIdentified) {
        return {
          kind: 'review-naming-inconsistency',
          proposal,
          confidence,
          blockers: [...(top ? [] : ['Nenhuma grafia tem maioria entre as ocorrências: não há hipótese de padronização.']), ...(sectorIdentified ? [] : [SECTOR_BLOCKER])],
          risks,
        };
      }
      return {
        kind: 'review-standardization',
        proposal,
        futureAction: {
          kind: 'name-standardization-review',
          executable: false,
          authorizesChanges: false,
          hypothesis: `Grafia predominante (${top.count} de ${top.total} ocorrências) como HIPÓTESE de padronização; não é regra oficial.`,
          preconditions: ['Confirmação do padrão oficial de nomenclatura do setor.', 'Revisão de cada ocorrência por uma pessoa.', 'Nova leitura VERIFICADA, autenticada e recente antes de qualquer ação.', SECTOR_PRECONDITION],
          hypothesisName: top.name,
        },
        confidence,
        blockers: [],
        risks,
      };
    }
    case 'NAME-SPACING': {
      const name = f.folders[0]?.name;
      return {
        kind: 'review-standardization',
        proposal: {
          summary: 'Revisar nome com espaço no início, no fim ou repetido.',
          justification: 'Espaços extras dificultam a busca e a comparação de nomes.',
          reviewQuestions: ['Os espaços extras são intencionais?'],
        },
        ...(sectorIdentified
          ? {
              futureAction: {
                kind: 'name-standardization-review' as const,
                executable: false as const,
                authorizesChanges: false as const,
                hypothesis: 'Nome sem espaços extras como HIPÓTESE de padronização.',
                preconditions: ['Revisão por uma pessoa.', 'Nova leitura VERIFICADA, autenticada e recente antes de qualquer ação.', SECTOR_PRECONDITION],
                ...(name !== undefined ? { hypothesisName: name.trim().replace(/\s+/g, ' ') } : {}),
              },
            }
          : {}),
        confidence: { level: 'high', basis: 'Espaços extras presentes no texto lido.' },
        blockers: sectorIdentified ? [] : [SECTOR_BLOCKER],
        risks: ['A leitura do AIR normaliza espaços do texto exibido: o nome real pode diferir.', ...COMMON_RISKS],
      };
    }
    case 'HIER-NESTED-SAME-NAME':
      return {
        kind: 'review-divergent-hierarchy',
        proposal: {
          summary: 'Revisar subpasta com o mesmo nome da pasta que a contém.',
          justification: 'O mesmo nome em níveis seguidos pode indicar um nível redundante, ou ser organização intencional.',
          reviewQuestions: ['O nível repetido é intencional?', 'Os documentos estão no nível esperado?'],
        },
        confidence: f.certainty === 'exact' ? { level: 'medium', basis: 'Nome textualmente idêntico ao da pasta que a contém.' } : { level: 'low', basis: 'Nome equivalente, após normalização, ao da pasta que a contém.' },
        blockers: ['Origem e destino não determináveis: a hierarquia pode ser intencional. Só revisão.'],
        risks: ['Reorganizar níveis pode quebrar referências conhecidas pelos usuários.', ...COMMON_RISKS],
      };
    case 'HIER-EQUIVALENT-CHILDREN': {
      const common = f.measures?.emComum ?? 0;
      const union = f.measures?.uniao ?? 0;
      return {
        kind: 'review-divergent-hierarchy',
        proposal: {
          summary: 'Revisar pastas equivalentes, em pais diferentes, com subpastas parcialmente diferentes.',
          justification: 'Estruturas quase iguais com diferenças podem indicar um padrão aplicado de forma desigual.',
          reviewQuestions: ['As duas estruturas deveriam seguir o mesmo padrão?', 'As subpastas que só existem de um lado são necessárias no outro?'],
        },
        confidence:
          union > 0 && common * 4 >= union * 3
            ? { level: 'medium', basis: 'Pelo menos 75% das subpastas diretas em comum (Jaccard).' }
            : { level: 'low', basis: 'Entre 50% e 75% das subpastas diretas em comum (Jaccard).' },
        blockers: [
          'Mesmo nome não implica conteúdo equivalente; só nomes de subpastas diretas foram comparados.',
          'Sem destino operacional: nenhuma pasta é criada, movida ou mesclada.',
        ],
        risks: ['Setores e pastas diferentes podem ter hierarquias legitimamente diferentes.', ...COMMON_RISKS],
      };
    }
  }
}

/**
 * Gera o plano. Recusa (sem propostas) qualquer inventário que não seja, AGORA: estruturalmente
 * válido, autenticado pela chave local, completo pela checagem própria e recente.
 */
export function planOrganization(input: unknown, options: PlanOptions): OrganizationPlan {
  const maxAgeDays = options.maxAgeDays ?? 7;
  const report = analyzeStructure(input, { now: options.now, maxAgeDays, ...(options.authenticator ? { authenticator: options.authenticator } : {}) });
  const inv = input as TreeInventoryExport;
  const structurallyValid = report.eligibility.status !== 'rejected';
  const basisProblems = structurallyValid ? planningBasisProblems(inv) : [];
  const mac = structurallyValid && report.integrity.status === 'authenticated' ? inv.integrity?.mac : undefined;
  const accepted = report.eligibility.status === 'planning-eligible' && report.integrity.status === 'authenticated' && basisProblems.length === 0 && mac !== undefined;

  const reasons = accepted ? [] : [...report.eligibility.reasons.map(String), ...basisProblems.map((p) => `completude: ${p}`)];
  if (!accepted && reasons.length === 0) reasons.push('inventário não autenticado');
  const validation: PlanValidation = {
    status: accepted ? 'accepted' : 'refused',
    integrity: report.integrity,
    ...(report.completeness ? { completeness: report.completeness } : {}),
    eligibility: report.eligibility,
    basisProblems,
    maxAgeDays,
    reasons: [...new Set(reasons)],
  };
  const base = {
    kind: PLAN_FORMAT as typeof PLAN_FORMAT,
    schemaVersion: 1 as const,
    plannerVersion: PLANNER_VERSION,
    engineVersion: ENGINE_VERSION,
    generatedAt: options.now.toISOString(),
    executable: false as const,
    authorizesChanges: false as const,
    authenticated: false as const,
    notices: PLAN_NOTICES,
  };
  if (!accepted) {
    return { ...base, identifiable: false, source: {}, validation, summary: { proposals: 0, byKind: emptyByKind(), withFutureAction: 0, withBlockers: 0 }, proposals: [] };
  }

  const inventoryId = inventoryIdentity(mac!);
  const sectorIdentified = inv.environment.sector.status === 'identified';
  const proposals: PlanProposal[] = report.findings.map((f) => {
    const draft = draftFor(f, sectorIdentified);
    return {
      id: proposalId(inventoryId, draft.kind, [f.id]),
      kind: draft.kind,
      status: 'pending-review',
      executable: false,
      observed: {
        findingIds: [f.id],
        rules: [f.rule],
        certainty: f.certainty,
        ...(f.matchedBy ? { matchedBy: f.matchedBy } : {}),
        ...(f.measures ? { measures: f.measures } : {}),
        folders: f.folders,
        ...(f.names ? { names: f.names } : {}),
        ...(f.relatedFindings ? { relatedFindings: f.relatedFindings } : {}),
      },
      proposal: draft.proposal,
      ...(draft.futureAction ? { futureAction: draft.futureAction } : {}),
      confidence: draft.confidence,
      blockers: draft.blockers,
      risks: draft.risks,
    };
  });
  // Estável: dentro do mesmo tipo, mantém a ordem determinística dos achados.
  proposals.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const byKind = emptyByKind();
  for (const p of proposals) byKind[p.kind]++;
  return {
    ...base,
    identifiable: true,
    source: {
      runId: inv.runId,
      ...(inv.checkpointRunId ? { checkpointRunId: inv.checkpointRunId } : {}),
      finishedAt: inv.finishedAt,
      sealedAt: inv.integrity!.sealedAt,
      inventoryId,
    },
    validation,
    observed: { coverage: report.coverage, findings: report.summary.findings, byRule: report.summary.byRule },
    summary: { proposals: proposals.length, byKind, withFutureAction: proposals.filter((p) => p.futureAction).length, withBlockers: proposals.filter((p) => p.blockers.length > 0).length },
    proposals,
  };
}

/** Versão sem dados identificáveis (padrão de console e de arquivo): sem nomes, caminhos, grafias nem runId. */
export function redactPlan(plan: OrganizationPlan): OrganizationPlan {
  const { runId: _r, checkpointRunId: _c, ...source } = plan.source;
  return {
    ...plan,
    identifiable: false,
    source,
    proposals: plan.proposals.map((p) => {
      const { names: _names, ...observed } = p.observed;
      const futureAction = p.futureAction ? (({ hypothesisName: _h, ...rest }) => rest)(p.futureAction) : undefined;
      return {
        ...p,
        observed: { ...observed, folders: observed.folders.map(({ name: _n, path: _p, ...e }) => e) },
        ...(futureAction ? { futureAction } : {}),
      };
    }),
  };
}

/** Linha de console de uma proposta, sem dados identificáveis. */
export function formatProposal(p: PlanProposal): string {
  const refs = p.observed.folders.map((e) => e.ref).join(', ');
  const future = p.futureAction ? ` · hipótese futura: ${p.futureAction.kind} (não executável)` : '';
  const blocked = p.blockers.length ? ` · impedimentos: ${p.blockers.length}` : '';
  return `${p.id} ${p.kind} [confiança ${p.confidence.level}] ${p.proposal.summary} Pastas: ${refs}${future}${blocked}`;
}
