import { describe, expect, it } from 'vitest';
import { resolveInstanceUrl } from '../../src/cli/args.js';
import { SafetyViolation } from '../../src/safety/scope-validator.js';

describe('resolveInstanceUrl', () => {
  it('aceita --url <url> e --url=<url>', () => {
    expect(resolveInstanceUrl(['--url', 'https://air.exemplo.test/air/'], {})?.href).toBe('https://air.exemplo.test/air/');
    expect(resolveInstanceUrl(['--url=https://air.exemplo.test/air/'], {})?.href).toBe('https://air.exemplo.test/air/');
  });

  it('usa AIR_ORGANIZER_URL quando não há argumento, e o argumento tem precedência', () => {
    expect(resolveInstanceUrl([], { AIR_ORGANIZER_URL: 'https://a.exemplo.test/' })?.href).toBe('https://a.exemplo.test/');
    expect(resolveInstanceUrl(['--url', 'https://b.exemplo.test/'], { AIR_ORGANIZER_URL: 'https://a.exemplo.test/' })?.href).toBe(
      'https://b.exemplo.test/',
    );
  });

  it('retorna undefined quando nada é informado', () => {
    expect(resolveInstanceUrl([], {})).toBeUndefined();
    expect(resolveInstanceUrl([], { AIR_ORGANIZER_URL: '  ' })).toBeUndefined();
  });

  it('remove query string e fragmento', () => {
    expect(resolveInstanceUrl(['--url', 'https://air.exemplo.test/air/?token=x#y'], {})?.href).toBe('https://air.exemplo.test/air/');
  });

  it('recusa HTTP, credenciais embutidas e --url sem valor', () => {
    expect(() => resolveInstanceUrl(['--url', 'http://air.exemplo.test/'], {})).toThrow(SafetyViolation);
    expect(() => resolveInstanceUrl(['--url', 'https://u:p@air.exemplo.test/'], {})).toThrow(SafetyViolation);
    expect(() => resolveInstanceUrl(['--url'], {})).toThrow(/após --url/);
    expect(() => resolveInstanceUrl(['--url', '--outro'], {})).toThrow(/após --url/);
  });
});
