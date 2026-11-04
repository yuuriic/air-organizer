import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { operationalConfig } from '../../src/app/runtime.js';
import { SETTING_ENV, applySettings, loadSettings, lockedFields, saveSettings, validateSettings } from '../../src/app/settings.js';
import { InvalidInput, parseLimits, parseOperator, parseResumeMode } from '../../src/app/validation.js';

describe('validação das configurações', () => {
  const abs = path.join(os.tmpdir(), 'dedicado');

  it('aceita o que é suportado e normaliza a URL (sem query nem fragmento)', () => {
    const { settings, errors } = validateSettings({ instanceUrl: 'https://air.sintetico.test/air?token=abc#x', profileDir: abs, checkpointDir: abs, maxPages: '20', pageTimeoutMs: 2000, retentionDays: 3, inventoryMaxAgeDays: 1 });
    expect(errors).toEqual({});
    expect(settings).toEqual({ instanceUrl: 'https://air.sintetico.test/air', profileDir: path.normalize(abs), checkpointDir: path.normalize(abs), maxPages: 20, pageTimeoutMs: 2000, retentionDays: 3, inventoryMaxAgeDays: 1 });
  });

  it('campo vazio não é gravado', () => {
    expect(validateSettings({ instanceUrl: '', maxPages: null })).toEqual({ settings: {}, errors: {} });
  });

  it.each([
    ['campo de segredo', { password: 'x' }, 'password'],
    ['token', { sessionToken: 'x' }, 'sessionToken'],
    ['URL sem HTTPS', { instanceUrl: 'http://air.test/' }, 'instanceUrl'],
    ['URL com credenciais', { instanceUrl: 'https://u:p@air.test/' }, 'instanceUrl'],
    ['perfil relativo', { profileDir: 'perfil' }, 'profileDir'],
    ['perfil pessoal do Chrome', { profileDir: path.join(abs, 'Google', 'Chrome', 'User Data') }, 'profileDir'],
    ['perfil dentro do repositório', { profileDir: path.join(process.cwd(), 'perfil') }, 'profileDir'],
    ['checkpoints dentro do repositório', { checkpointDir: path.join(process.cwd(), 'cp') }, 'checkpointDir'],
    ['número fracionário', { maxPages: 1.5 }, 'maxPages'],
    ['abaixo do mínimo', { pageTimeoutMs: 10 }, 'pageTimeoutMs'],
    ['acima do máximo', { retentionDays: 9999 }, 'retentionDays'],
    ['texto em número', { inventoryMaxAgeDays: 'abc' }, 'inventoryMaxAgeDays'],
  ])('recusa %s, sem repetir o valor', (_, input, field) => {
    const { errors } = validateSettings(input);
    expect(errors[field]).toBeTruthy();
    expect(JSON.stringify(errors)).not.toContain('u:p');
  });

  it.each([[null], [[]], ['texto'], [3]])('recusa documento inválido (%j)', (input) => {
    expect(validateSettings(input).errors.form).toBeTruthy();
  });
});

describe('arquivo de configurações', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-settings-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('grava e lê; ausente = sem configurações', async () => {
    const file = path.join(dir, 'sub', 'settings.json');
    expect(await loadSettings(file)).toEqual({ settings: {} });
    await saveSettings(file, { maxPages: 9 });
    expect(await loadSettings(file)).toEqual({ settings: { maxPages: 9 } });
  });

  it('corrompido ou com campo desconhecido: ignorado com aviso e preservado no disco', async () => {
    const file = path.join(dir, 'settings.json');
    for (const content of ['{quebrado', JSON.stringify({ maxPages: 9, password: 'x' })]) {
      await writeFile(file, content);
      const loaded = await loadSettings(file);
      expect(loaded.settings).toEqual({});
      expect(loaded.problem).toBeTruthy();
      expect(loaded.problem).not.toContain('password');
      expect(await readFile(file, 'utf-8')).toBe(content);
    }
  });
});

describe('compatibilidade com a CLI', () => {
  it('usa as mesmas variáveis de ambiente e a variável definida tem precedência', () => {
    const base = { AIR_ORGANIZER_MAX_PAGES: '11' };
    const env: Record<string, string | undefined> = { ...base };
    applySettings(env, base, { maxPages: 99, pageTimeoutMs: 2000 });
    expect(operationalConfig(env)).toMatchObject({ maxPages: 11, pageTimeoutMs: 2000 });
    expect(lockedFields(base)).toEqual(['maxPages']);
    applySettings(env, base, {});
    expect(env.AIR_ORGANIZER_PAGE_TIMEOUT_MS).toBeUndefined();
    expect(env.AIR_ORGANIZER_MAX_PAGES).toBe('11');
  });

  it('todos os campos correspondem a variáveis documentadas', async () => {
    const example = await readFile(path.join(process.cwd(), '.env.example'), 'utf-8');
    for (const name of Object.values(SETTING_ENV)) expect(example).toContain(name);
  });

  it('padrões iguais aos da CLI', () => {
    expect(operationalConfig({})).toEqual({ maxPages: 500, pageTimeoutMs: 15_000, pollMs: 300, retentionDays: 7, inventoryMaxAgeDays: 7, verboseErrors: false });
  });
});

describe('validação das entradas da janela', () => {
  const ok = { maxDepth: 0, maxFolders: 1, maxItems: 1, maxPagesPerFolder: 1 };

  it('limites: mesmos mínimos da CLI, só inteiros, sem campo extra no resultado', () => {
    expect(parseLimits({ ...ok, extra: 5 })).toEqual(ok);
    for (const bad of [undefined, null, 'x', {}, { ...ok, maxDepth: -1 }, { ...ok, maxFolders: 0 }, { ...ok, maxItems: 1.5 }, { ...ok, maxPagesPerFolder: '2' }, { ...ok, maxItems: Infinity }]) {
      expect(() => parseLimits(bad)).toThrow(InvalidInput);
    }
  });

  it('cliente e setor: vazio mantém o anterior; recusa controle e excesso, sem repetir o valor', () => {
    expect(parseOperator({ client: ' C ', sector: '' }, { sector: 'S' })).toEqual({ client: 'C', sector: 'S' });
    expect(parseOperator(undefined, { client: 'C' })).toEqual({ client: 'C' });
    expect(() => parseOperator({ client: 'a\u0000b' }, {})).toThrow(InvalidInput);
    expect(() => parseOperator({ sector: 'x'.repeat(201) }, {})).toThrow(/Setor inválido\.$/);
    expect(() => parseOperator({ client: 5 }, {})).toThrow(InvalidInput);
    expect(() => parseOperator('x', {})).toThrow(InvalidInput);
  });

  it('modo de retomada', () => {
    expect(parseResumeMode('verified')).toBe('verified');
    expect(parseResumeMode('fast')).toBe('fast');
    expect(() => parseResumeMode('outro')).toThrow(InvalidInput);
  });
});
