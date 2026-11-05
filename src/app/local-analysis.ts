import { planMovements, type MovementPlan, type MovementRequest } from '../core/movement-planner.js';
import { planOrganization, type OrganizationPlan } from '../core/organization-planner.js';
import { analyzeStructure, type StructuralReport } from '../core/structural-diagnostics.js';
import { DEFAULT_OUTPUT_DIR } from '../storage/export.js';
import { openVerifyingAuthenticator, type KeyUnavailable } from '../storage/integrity-key.js';
import { readInventory } from '../storage/inventory-files.js';

export type LocalAnalysisOptions = { keyFile: string; maxAgeDays: number; outputDir?: string; now?: Date };

/**
 * Diagnóstico e planejamento locais, sem navegador e sem acesso ao AIR. A verificação nunca cria a
 * chave local: sem ela, o selo não é verificável.
 */
async function prepare(file: string, options: LocalAnalysisOptions) {
  const key = await openVerifyingAuthenticator(options.keyFile);
  return {
    input: await readInventory(file, options.outputDir ?? DEFAULT_OUTPUT_DIR),
    analysis: { now: options.now ?? new Date(), maxAgeDays: options.maxAgeDays, ...('authenticator' in key ? { authenticator: key.authenticator } : {}) },
    ...('unavailable' in key ? { keyUnavailable: key.unavailable } : {}),
  };
}

export async function diagnoseInventory(file: string, options: LocalAnalysisOptions): Promise<{ report: StructuralReport; keyUnavailable?: KeyUnavailable }> {
  const { input, analysis, keyUnavailable } = await prepare(file, options);
  return { report: analyzeStructure(input, analysis), ...(keyUnavailable ? { keyUnavailable } : {}) };
}

export async function planInventory(file: string, options: LocalAnalysisOptions): Promise<{ plan: OrganizationPlan; keyUnavailable?: KeyUnavailable }> {
  const { input, analysis, keyUnavailable } = await prepare(file, options);
  return { plan: planOrganization(input, analysis), ...(keyUnavailable ? { keyUnavailable } : {}) };
}

/** Prévia de movimentações sobre inventário gravado (POC-03A). Só gera propostas: nada é gravado nem movido. */
export async function planInventoryMovements(file: string, request: MovementRequest, options: LocalAnalysisOptions): Promise<{ plan: MovementPlan; keyUnavailable?: KeyUnavailable }> {
  const { input, analysis, keyUnavailable } = await prepare(file, options);
  return { plan: planMovements(input, request, analysis), ...(keyUnavailable ? { keyUnavailable } : {}) };
}
