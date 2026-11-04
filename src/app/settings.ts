import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertNotPersonalProfile } from '../air/session.js';
import { assertOutsideRepository, sanitizeUrl } from '../safety/scope-validator.js';

/**
 * Configurações locais do aplicativo (settings.json no perfil do usuário). Só parâmetros que a CLI
 * já suporta por variável de ambiente, e nenhum segredo: campo desconhecido é recusado e URL com
 * credenciais não é aceita. A CLI não lê este arquivo; variável de ambiente definida tem precedência.
 */
export type Settings = {
  instanceUrl?: string;
  profileDir?: string;
  checkpointDir?: string;
  maxPages?: number;
  pageTimeoutMs?: number;
  retentionDays?: number;
  inventoryMaxAgeDays?: number;
};

export type SettingField = keyof Settings;

export const SETTING_ENV: Record<SettingField, string> = {
  instanceUrl: 'AIR_ORGANIZER_URL',
  profileDir: 'AIR_ORGANIZER_PROFILE_DIR',
  checkpointDir: 'AIR_ORGANIZER_CHECKPOINT_DIR',
  maxPages: 'AIR_ORGANIZER_MAX_PAGES',
  pageTimeoutMs: 'AIR_ORGANIZER_PAGE_TIMEOUT_MS',
  retentionDays: 'AIR_ORGANIZER_CHECKPOINT_RETENTION_DAYS',
  inventoryMaxAgeDays: 'AIR_ORGANIZER_INVENTORY_MAX_AGE_DAYS',
};

const NUMERIC: Partial<Record<SettingField, { min: number; max: number }>> = {
  maxPages: { min: 1, max: 100_000 },
  pageTimeoutMs: { min: 1_000, max: 300_000 },
  retentionDays: { min: 1, max: 365 },
  inventoryMaxAgeDays: { min: 1, max: 365 },
};

const isField = (key: string): key is SettingField => Object.hasOwn(SETTING_ENV, key);

function validatePath(field: 'profileDir' | 'checkpointDir', value: string): string {
  if (!path.isAbsolute(value)) throw new Error('Informe um caminho absoluto.');
  if (field === 'profileDir') assertNotPersonalProfile(value);
  else assertOutsideRepository([value]);
  return path.normalize(value);
}

/** Valida tudo; campo vazio = não definido. Mensagens não repetem o valor informado. */
export function validateSettings(input: unknown): { settings: Settings; errors: Partial<Record<string, string>> } {
  const settings: Settings = {};
  const errors: Partial<Record<string, string>> = {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { settings, errors: { form: 'Configurações inválidas.' } };
  for (const [key, raw] of Object.entries(input)) {
    if (!isField(key)) {
      errors[key] = 'Campo não suportado.';
      continue;
    }
    if (raw === undefined || raw === null || raw === '') continue;
    const range = NUMERIC[key];
    if (range) {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
      if (!Number.isInteger(n) || n < range.min || n > range.max) errors[key] = `Informe um inteiro entre ${range.min} e ${range.max}.`;
      else (settings[key] as number) = n;
      continue;
    }
    if (typeof raw !== 'string') {
      errors[key] = 'Valor inválido.';
      continue;
    }
    try {
      if (key === 'instanceUrl') settings.instanceUrl = sanitizeUrl(raw.trim()).href;
      else settings[key as 'profileDir' | 'checkpointDir'] = validatePath(key as 'profileDir' | 'checkpointDir', raw.trim());
    } catch (error) {
      errors[key] = key === 'instanceUrl' ? 'Use uma URL HTTPS, sem credenciais.' : error instanceof Error && error.message === 'Informe um caminho absoluto.' ? error.message : 'Diretório não permitido: use um local dedicado, fora do repositório e do perfil pessoal do navegador.';
    }
  }
  return { settings, errors };
}

/** Arquivo ausente = sem configurações. Arquivo inválido é ignorado inteiro, com aviso, e não é apagado. */
export async function loadSettings(file: string): Promise<{ settings: Settings; problem?: string }> {
  let text: string;
  try {
    text = await readFile(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { settings: {} };
    return { settings: {}, problem: 'O arquivo de configurações não pôde ser lido; valem os padrões.' };
  }
  try {
    const { settings, errors } = validateSettings(JSON.parse(text));
    if (Object.keys(errors).length > 0) return { settings: {}, problem: 'O arquivo de configurações tem valores inválidos e foi ignorado; valem os padrões.' };
    return { settings };
  } catch {
    return { settings: {}, problem: 'O arquivo de configurações está corrompido e foi ignorado; valem os padrões.' };
  }
}

export async function saveSettings(file: string, settings: Settings): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(settings, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await rename(temp, file);
}

/** Campos definidos por variável de ambiente no início do processo: têm precedência e não são editados. */
export const lockedFields = (baseEnv: Record<string, string | undefined>): SettingField[] =>
  (Object.keys(SETTING_ENV) as SettingField[]).filter((field) => baseEnv[SETTING_ENV[field]]?.trim());

/** Aplica as configurações ao ambiente deste processo, respeitando as variáveis já definidas. */
export function applySettings(env: Record<string, string | undefined>, baseEnv: Record<string, string | undefined>, settings: Settings): void {
  for (const field of Object.keys(SETTING_ENV) as SettingField[]) {
    const name = SETTING_ENV[field];
    if (baseEnv[name]?.trim()) continue;
    const value = settings[field];
    if (value === undefined) delete env[name];
    else env[name] = String(value);
  }
}
