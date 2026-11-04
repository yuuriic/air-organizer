import { DEFAULT_RETENTION_DAYS } from '../storage/checkpoints.js';

/** Parâmetros operacionais já suportados, lidos das variáveis de ambiente. */
export type OperationalConfig = {
  maxPages: number;
  pageTimeoutMs: number;
  pollMs: number;
  retentionDays: number;
  inventoryMaxAgeDays: number;
  verboseErrors: boolean;
};

export function operationalConfig(env: Record<string, string | undefined> = process.env): OperationalConfig {
  return {
    maxPages: Number(env.AIR_ORGANIZER_MAX_PAGES ?? 500),
    pageTimeoutMs: Number(env.AIR_ORGANIZER_PAGE_TIMEOUT_MS ?? 15_000),
    pollMs: 300,
    retentionDays: Number(env.AIR_ORGANIZER_CHECKPOINT_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS),
    inventoryMaxAgeDays: Number(env.AIR_ORGANIZER_INVENTORY_MAX_AGE_DAYS ?? 7),
    verboseErrors: env.AIR_ORGANIZER_VERBOSE_ERRORS === '1',
  };
}
