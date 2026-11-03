import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNotPersonalProfile } from '../../src/air/session.js';
import {
  SafetyViolation,
  assertInsideDirectory,
  assertReadOnlyAction,
  assertReadOnlyMode,
  compareScope,
  fingerprintOf,
  sanitizeUrl,
  validateAnalysisScope,
} from '../../src/safety/scope-validator.js';
import type { AirEnvironment } from '../../src/types/inventory.js';

function env(overrides: Partial<AirEnvironment> = {}): AirEnvironment {
  return {
    instanceOrigin: { status: 'identified', value: 'https://air.exemplo.test', source: 'url' },
    pageUrl: { status: 'identified', value: 'https://air.exemplo.test/pastas', source: 'url' },
    client: { status: 'identified', value: 'Cliente A', source: 'operator' },
    sector: { status: 'identified', value: 'Setor X', source: 'operator' },
    currentFolder: { status: 'identified', value: 'Raiz', source: 'breadcrumb' },
    breadcrumb: { status: 'identified', value: ['Setor X', 'Raiz'], source: 'breadcrumb' },
    observedAt: '2026-10-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('assertReadOnlyAction', () => {
  it.each(['Próxima', 'Próxima página', 'Next', 'Go to next page', 'proxima'])('permite paginação: %s', (label) => {
    expect(() => assertReadOnlyAction('pagination-next', label)).not.toThrow();
  });

  it.each(['Mover para', 'Itens selecionados', 'Select all', 'Select row', 'Excluir', 'Renomear', 'Criar pasta', 'Download', 'Nova pasta', 'Próxima e mover'])(
    'bloqueia: %s',
    (label) => {
      expect(() => assertReadOnlyAction('pagination-next', label)).toThrow(SafetyViolation);
    },
  );

  it('aceita o rótulo sintético do botão só com ícone, e nada parecido', () => {
    expect(() => assertReadOnlyAction('pagination-next', 'icon:chevron-right')).not.toThrow();
    expect(() => assertReadOnlyAction('pagination-next', 'icon:chevron-left')).toThrow(SafetyViolation);
    expect(() => assertReadOnlyAction('pagination-next', 'Next slide')).toThrow(SafetyViolation);
    expect(() => assertReadOnlyAction('pagination-next', '')).toThrow(SafetyViolation);
  });

  it('bloqueia rótulos desconhecidos', () => {
    expect(() => assertReadOnlyAction('pagination-next', 'Abrir')).toThrow(SafetyViolation);
  });
});

describe('assertReadOnlyMode', () => {
  it('só aceita modo somente leitura', () => {
    expect(() => assertReadOnlyMode(true)).not.toThrow();
    expect(() => assertReadOnlyMode(false)).toThrow(SafetyViolation);
  });
});

describe('sanitizeUrl', () => {
  it('remove query string e fragmento', () => {
    expect(sanitizeUrl('https://air.exemplo.test/pastas?token=abc#x').href).toBe('https://air.exemplo.test/pastas');
  });

  it('exige HTTPS', () => {
    expect(() => sanitizeUrl('http://air.exemplo.test')).toThrow(SafetyViolation);
    expect(() => sanitizeUrl('file:///c:/x')).toThrow(SafetyViolation);
  });

  it('aceita HTTP local só quando permitido', () => {
    expect(() => sanitizeUrl('http://localhost:3000')).toThrow(SafetyViolation);
    expect(sanitizeUrl('http://localhost:3000/x', { allowInsecureLocal: true }).origin).toBe('http://localhost:3000');
  });

  it('rejeita credenciais embutidas', () => {
    expect(() => sanitizeUrl('https://user:pw@air.exemplo.test')).toThrow(SafetyViolation);
  });
});

describe('validateAnalysisScope', () => {
  it('aceita ambiente com origem e pasta identificadas', () => {
    expect(validateAnalysisScope(env())).toEqual([]);
  });

  it('bloqueia sem origem ou sem pasta', () => {
    const problems = validateAnalysisScope(
      env({
        instanceOrigin: { status: 'not-identified', reason: 'x' },
        currentFolder: { status: 'not-identified', reason: 'x' },
        breadcrumb: { status: 'not-identified', reason: 'x' },
      }),
    );
    expect(problems).toHaveLength(2);
  });

  it('cliente e setor não identificados não inventam valores', () => {
    const fp = fingerprintOf(env({ sector: { status: 'not-identified', reason: 'x' } }));
    expect(fp.sector).toBeUndefined();
  });
});

describe('compareScope', () => {
  it('sem mudanças, sem problemas', () => {
    expect(compareScope(fingerprintOf(env()), fingerprintOf(env()))).toEqual([]);
  });

  it('detecta mudança de origem, setor e breadcrumb', () => {
    const changed = env({
      instanceOrigin: { status: 'identified', value: 'https://outra.test', source: 'url' },
      sector: { status: 'identified', value: 'Setor Y', source: 'operator' },
      breadcrumb: { status: 'identified', value: ['Setor X', 'Raiz', 'Sub'], source: 'breadcrumb' },
    });
    expect(compareScope(fingerprintOf(env()), fingerprintOf(changed))).toHaveLength(3);
  });

  it('detecta mudança de URL e de pasta atual (AIR sem breadcrumb)', () => {
    const changed = env({
      pageUrl: { status: 'identified', value: 'https://air.exemplo.test/air/my-air/OUTRA', source: 'url' },
      currentFolder: { status: 'identified', value: 'Outra', source: 'page-heading' },
    });
    expect(compareScope(fingerprintOf(env()), fingerprintOf(changed))).toHaveLength(2);
  });
});

describe('assertInsideDirectory', () => {
  it('permite caminhos internos e bloqueia travessia', () => {
    expect(assertInsideDirectory('output', 'a/b/inventory.json')).toBe(path.resolve('output/a/b/inventory.json'));
    expect(() => assertInsideDirectory('output', '../fora.json')).toThrow(SafetyViolation);
    expect(() => assertInsideDirectory('output', path.resolve('/tmp/x.json'))).toThrow(SafetyViolation);
  });
});

describe('assertNotPersonalProfile', () => {
  it('recusa perfis pessoais do Chrome e diretórios dentro do repositório', () => {
    expect(() => assertNotPersonalProfile('C:/Users/u/AppData/Local/Google/Chrome/User Data')).toThrow(SafetyViolation);
    expect(() => assertNotPersonalProfile(path.join(process.cwd(), 'chrome-profile'))).toThrow(SafetyViolation);
    // Caminho absoluto fora do repositório em qualquer SO ("C:/..." não é absoluto no Linux da CI).
    expect(() => assertNotPersonalProfile(path.join(os.tmpdir(), 'air-organizer', 'chrome-profile'))).not.toThrow();
  });
});
