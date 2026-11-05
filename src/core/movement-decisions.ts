import { timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './checkpoint.js';
import type { InventoryAuthenticator } from './inventory-integrity.js';
import type { MovementPlan, MovementProposal } from './movement-planner.js';

/**
 * Decisões humanas sobre propostas de movimentação (POC-03B, Incremento B; ARCHITECTURE.md §9.5).
 * Sem navegador, sem sistema de arquivos e sem rede. Uma decisão só registra a revisão do operador:
 * NÃO autoriza execução, não altera a proposta e não muda o estado calculado pelo motor.
 *
 * - Aprovar exige que o MOTOR considere a proposta apta agora: quem chama nunca informa o estado.
 * - Uma decisão vale para o conteúdo exato da proposta, conferido pela assinatura. Mudou o conteúdo,
 *   o inventário ou a versão do planejamento: a decisão deixa de valer e a proposta volta a pendente.
 * - A assinatura e o selo são HMAC: o arquivo sozinho não permite confirmar nomes por tentativa.
 */

export const DECISIONS_FORMAT = 'air-organizer/movement-decisions';
export const MAX_JUSTIFICATION_LENGTH = 500;

export type HumanDecision = 'approved' | 'rejected';

/** Qual planejamento produziu a proposta decidida. */
export type PlanningReference = { format: string; schemaVersion: number; plannerVersion: string; engineVersion: string };

/** Sem nomes nem caminhos. A justificativa é texto do operador e fica fora das visões até a revelação. */
export type DecisionRecord = {
  inventoryId: string;
  proposalId: string;
  signature: string;
  decision: HumanDecision;
  decidedAt: string;
  justification?: string;
  planning: PlanningReference;
  executable: false;
  authorizesChanges: false;
};

export type DecisionDocument = {
  kind: typeof DECISIONS_FORMAT;
  schemaVersion: 1;
  inventoryId: string;
  keyId: string;
  executable: false;
  authorizesChanges: false;
  /** Histórico em ordem de registro. A última decisão de cada proposta é a vigente. */
  decisions: DecisionRecord[];
  seal: string;
};

/** Decisão vigente de uma proposta, depois de conferida contra o plano atual. */
export type ProposalDecisionState = {
  status: 'pending' | HumanDecision;
  approvable: boolean;
  approvalRefusal?: string;
  decidedAt?: string;
  hasJustification: boolean;
  /** A última decisão registrada deixou de valer. */
  invalidated?: 'content-changed' | 'not-approvable';
  /** Registros desta proposta no histórico, inclusive os que deixaram de valer. */
  history: number;
  authorizesExecution: false;
};

/** `approved + rejected + pending + notApprovable` = total de propostas. */
export type DecisionSummary = { approved: number; rejected: number; pending: number; notApprovable: number; invalidated: number };

const INVENTORY_ID = /^[0-9a-f]{16}$/;
const PROPOSAL_ID = /^M-[0-9a-f]{16}$/;
const HEX_MAC = /^[0-9a-f]{64}$/;
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const isInventoryId = (value: unknown): value is string => typeof value === 'string' && INVENTORY_ID.test(value);
export const isProposalId = (value: unknown): value is string => typeof value === 'string' && PROPOSAL_ID.test(value);
export const isValidJustification = (value: unknown): value is string => typeof value === 'string' && value !== '' && value === value.trim() && value.length <= MAX_JUSTIFICATION_LENGTH && !FORBIDDEN_CONTROL.test(value);

/** Plano ou proposta que se apresente como executável é erro de contrato: nada é registrado sobre ele. */
function assertNotExecutable(plan: MovementPlan, proposal: MovementProposal): void {
  const contractHolds = plan.executable === false && plan.authorizesChanges === false && proposal.executable === false && proposal.authorizesChanges === false && (proposal.group === undefined || proposal.group.authorizesOperations === false);
  if (!contractHolds) throw new Error('Contrato do plano violado: proposta apresentada como executável.');
}

/**
 * Por que a proposta não pode ser aprovada, ou `undefined` se pode. Rejeitar é sempre possível.
 * Uma consolidação parcial não é aprovada de uma vez: só cada operação apta, individualmente.
 */
export function approvalRefusal(proposal: MovementProposal): string | undefined {
  if (proposal.state !== 'ready-for-review') return proposal.state === 'blocked' ? 'proposta bloqueada pelo motor; veja os conflitos e bloqueios.' : 'proposta ainda não avaliada pelo motor.';
  if (proposal.group?.status === 'partially-blocked' || proposal.group?.status === 'fully-blocked') return 'consolidação com operações bloqueadas; aprove apenas as operações aptas, uma a uma.';
  return undefined;
}

export const planningReference = (plan: MovementPlan): PlanningReference => ({ format: plan.kind, schemaVersion: plan.schemaVersion, plannerVersion: plan.plannerVersion, engineVersion: plan.engineVersion });

/** Identidade do conteúdo: mesma proposta, mesmo inventário e mesma versão do planejamento. */
export function proposalSignature(plan: MovementPlan, proposal: MovementProposal, auth: InventoryAuthenticator): string {
  const content = JSON.parse(JSON.stringify({ inventoryId: plan.source.inventoryId, planning: planningReference(plan), proposal })) as unknown;
  return auth.mac(`${DECISIONS_FORMAT}/signature\u0000${canonicalJson(content)}`).toString('hex');
}

export class DecisionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionRefused';
  }
}

/** Único caminho para criar um registro: a regra de aprovação vale para qualquer chamador. */
export function createDecisionRecord(plan: MovementPlan, proposal: MovementProposal, decision: HumanDecision, justification: string | undefined, now: Date, auth: InventoryAuthenticator): DecisionRecord {
  assertNotExecutable(plan, proposal);
  const inventoryId = plan.source.inventoryId;
  if (plan.validation.status !== 'accepted' || !isInventoryId(inventoryId)) throw new DecisionRefused('Este inventário não aceita decisões agora.');
  if (decision === 'approved') {
    const refusal = approvalRefusal(proposal);
    if (refusal) throw new DecisionRefused(`Aprovação não permitida: ${refusal}`);
  }
  if (justification !== undefined && !isValidJustification(justification)) throw new DecisionRefused('Justificativa inválida.');
  return {
    inventoryId,
    proposalId: proposal.id,
    signature: proposalSignature(plan, proposal, auth),
    decision,
    decidedAt: now.toISOString(),
    ...(justification !== undefined ? { justification } : {}),
    planning: planningReference(plan),
    executable: false,
    authorizesChanges: false,
  };
}

const sealOf = (unsealed: Omit<DecisionDocument, 'seal'>, auth: InventoryAuthenticator) => auth.mac(`${DECISIONS_FORMAT}/seal\u0000${canonicalJson(JSON.parse(JSON.stringify(unsealed)))}`).toString('hex');

export function sealDecisions(inventoryId: string, decisions: DecisionRecord[], auth: InventoryAuthenticator): DecisionDocument {
  const unsealed = { kind: DECISIONS_FORMAT, schemaVersion: 1, inventoryId, keyId: auth.keyId, executable: false, authorizesChanges: false, decisions } as const;
  return { ...unsealed, decisions, seal: sealOf({ ...unsealed, decisions }, auth) };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOnlyKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every((k) => k in value) && Object.keys(value).every((k) => required.includes(k) || optional.includes(k));
const isTimestamp = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

function isValidPlanning(value: unknown): value is PlanningReference {
  return isRecord(value) && hasOnlyKeys(value, ['format', 'schemaVersion', 'plannerVersion', 'engineVersion']) && typeof value.format === 'string' && typeof value.schemaVersion === 'number' && typeof value.plannerVersion === 'string' && typeof value.engineVersion === 'string';
}

function isValidRecord(value: unknown, inventoryId: string): value is DecisionRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, ['inventoryId', 'proposalId', 'signature', 'decision', 'decidedAt', 'planning', 'executable', 'authorizesChanges'], ['justification'])) return false;
  return (
    value.inventoryId === inventoryId &&
    isProposalId(value.proposalId) &&
    typeof value.signature === 'string' &&
    HEX_MAC.test(value.signature) &&
    (value.decision === 'approved' || value.decision === 'rejected') &&
    isTimestamp(value.decidedAt) &&
    (value.justification === undefined || isValidJustification(value.justification)) &&
    isValidPlanning(value.planning) &&
    value.executable === false &&
    value.authorizesChanges === false
  );
}

/**
 * Validação ao carregar: formato estrito e selo do documento inteiro. Qualquer divergência, inclusive
 * edição manual ou arquivo de outro inventário, invalida o arquivo todo: nenhuma decisão é aproveitada.
 */
export function parseDecisionDocument(input: unknown, inventoryId: string, auth: InventoryAuthenticator): DecisionRecord[] | undefined {
  if (!isRecord(input) || !hasOnlyKeys(input, ['kind', 'schemaVersion', 'inventoryId', 'keyId', 'executable', 'authorizesChanges', 'decisions', 'seal'])) return undefined;
  if (input.kind !== DECISIONS_FORMAT || input.schemaVersion !== 1 || input.inventoryId !== inventoryId || input.keyId !== auth.keyId) return undefined;
  if (input.executable !== false || input.authorizesChanges !== false || typeof input.seal !== 'string' || !HEX_MAC.test(input.seal)) return undefined;
  if (!Array.isArray(input.decisions) || !input.decisions.every((record) => isValidRecord(record, inventoryId))) return undefined;
  const { seal, ...unsealed } = input as unknown as DecisionDocument;
  const expected = Buffer.from(sealOf(unsealed, auth), 'hex');
  return timingSafeEqual(Buffer.from(seal, 'hex'), expected) ? unsealed.decisions : undefined;
}

/**
 * Confere o histórico contra o plano atual. O estado do motor sempre prevalece: nem uma assinatura
 * válida faz valer a aprovação de proposta que o motor não considera apta agora.
 */
export function reconcileDecisions(plan: MovementPlan, records: DecisionRecord[], auth: InventoryAuthenticator): { states: Map<string, ProposalDecisionState>; summary: DecisionSummary } {
  const history = new Map<string, DecisionRecord[]>();
  for (const record of records) history.set(record.proposalId, [...(history.get(record.proposalId) ?? []), record]);
  const states = new Map<string, ProposalDecisionState>();
  const summary: DecisionSummary = { approved: 0, rejected: 0, pending: 0, notApprovable: 0, invalidated: 0 };
  for (const proposal of plan.proposals) {
    assertNotExecutable(plan, proposal);
    const refusal = approvalRefusal(proposal);
    const own = history.get(proposal.id) ?? [];
    const last = own.at(-1);
    const invalidated = !last ? undefined : last.signature !== proposalSignature(plan, proposal, auth) ? ('content-changed' as const) : last.decision === 'approved' && refusal ? ('not-approvable' as const) : undefined;
    const current = last && !invalidated ? last : undefined;
    const status = current?.decision ?? 'pending';
    if (status !== 'pending') summary[status]++;
    else if (refusal) summary.notApprovable++;
    else summary.pending++;
    if (invalidated) summary.invalidated++;
    states.set(proposal.id, {
      status,
      approvable: refusal === undefined,
      ...(refusal ? { approvalRefusal: refusal } : {}),
      ...(current ? { decidedAt: current.decidedAt } : {}),
      hasJustification: current?.justification !== undefined,
      ...(invalidated ? { invalidated } : {}),
      history: own.length,
      authorizesExecution: false,
    });
  }
  return { states, summary };
}

/** Justificativa vigente registrada para cada proposta: só sai por revelação explícita. */
export function latestJustifications(records: DecisionRecord[]): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const record of records) {
    if (record.justification !== undefined) notes[record.proposalId] = record.justification;
    else delete notes[record.proposalId];
  }
  return notes;
}
