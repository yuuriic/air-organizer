import { describe, expect, it } from 'vitest';
import { findDuplicateSuspicions, normalizeName, requiredRules } from '../../src/core/duplicates.js';
import { parseRows } from '../../src/core/records.js';
import { row } from '../helpers.js';

function items(names: string[], kindHints: string[] = ['class=lucide lucide-folder']) {
  return parseRows(
    names.map((n) => row(n, {}, kindHints)),
    { pageNumber: 1, observedAt: '2026-10-29T00:00:00.000Z' },
  ).items;
}

describe('normalizeName', () => {
  it('ignora maiúsculas/minúsculas', () => {
    expect(normalizeName('PLANETAS')).toBe(normalizeName('Planetas'));
  });

  it('ignora acentuação', () => {
    expect(normalizeName('ORBITAS')).toBe(normalizeName('ÓRBITAS'));
    expect(normalizeName('Observação')).toBe('observacao');
  });

  it('colapsa espaços repetidos e aplica trim', () => {
    expect(normalizeName('  Mapas   Estelares ')).toBe('mapas estelares');
    expect(normalizeName('Mapas\tEstelares')).toBe('mapas estelares');
  });

  it('trata pontuação simples como separador', () => {
    expect(normalizeName('Mapas-Estelares')).toBe('mapas estelares');
    expect(normalizeName('Mapas_Estelares.')).toBe('mapas estelares');
    expect(normalizeName('Catalogo (2031)')).toBe(normalizeName('Catalogo 2031'));
  });

  it('trata formas Unicode compostas e decompostas igualmente', () => {
    expect(normalizeName('O\u0301rbitas')).toBe(normalizeName('\u00d3rbitas'));
  });

  it('não remove dígitos nem funde palavras distintas', () => {
    expect(normalizeName('Catalogo-2031')).not.toBe(normalizeName('Catalogo'));
    expect(normalizeName('Planeta 1')).not.toBe(normalizeName('Planeta 11'));
  });

  it('identifica as regras necessárias para a equivalência', () => {
    expect(requiredRules(['PLANETAS', 'Planetas'])).toEqual(['case']);
    expect(requiredRules(['ORBITAS', 'ÓRBITAS'])).toEqual(['diacritics']);
    expect(requiredRules(['A  B', 'A B'])).toEqual(['whitespace']);
  });
});

describe('findDuplicateSuspicions', () => {
  it('detecta pares equivalentes por caixa e acento como SUSPEITAS', () => {
    const result = findDuplicateSuspicions(
      items(['PLANETAS', 'Planetas', 'ORBITAS', 'ÓRBITAS', 'COMETAS', 'Cometas', 'Catalogo', 'Catalogo-2031']),
    );
    const names = result.map((s) => s.items.map((i) => i.name).sort());
    expect(names).toEqual([
      ['COMETAS', 'Cometas'],
      ['ORBITAS', 'ÓRBITAS'],
      ['PLANETAS', 'Planetas'],
    ]);
    for (const s of result) {
      expect(s.classification).toBe('suspected-duplicate');
      expect(s.requiresHumanReview).toBe(true);
    }
  });

  it('não considera "Catalogo" e "Catalogo-2031" duplicidade', () => {
    expect(findDuplicateSuspicions(items(['Catalogo', 'Catalogo-2031']))).toEqual([]);
  });

  it('atribui confiança alta para caixa e média para acento/pontuação', () => {
    const byName = Object.fromEntries(
      findDuplicateSuspicions(items(['PLANETAS', 'Planetas', 'ORBITAS', 'ÓRBITAS', 'Mapas-Estelares', 'Mapas Estelares'])).map(
        (s) => [s.normalizedName, s.confidence],
      ),
    );
    expect(byName).toEqual({ planetas: 'high', orbitas: 'medium', 'mapas estelares': 'medium' });
  });

  it('agrupa nomes idênticos (homônimos) sem afirmar igualdade de conteúdo', () => {
    const [s] = findDuplicateSuspicions(items(['Cometas', 'Cometas']));
    expect(s?.items).toHaveLength(2);
    expect(s?.matchedBy).toEqual([]);
    expect(new Set(s?.items.map((i) => i.observationKey)).size).toBe(2);
  });

  it('não agrupa pasta e arquivo com o mesmo nome', () => {
    const mixed = [...items(['Relatorio'], ['class=lucide-folder']), ...items(['Relatorio'], ['class=lucide-file-text'])];
    expect(findDuplicateSuspicions(mixed)).toEqual([]);
  });

  it('é determinístico', () => {
    const input = items(['B', 'b', 'A', 'a', 'Á']);
    expect(findDuplicateSuspicions(input)).toEqual(findDuplicateSuspicions([...input].reverse()).map((s) => ({
      ...s,
      items: [...s.items].reverse(),
    })));
    expect(findDuplicateSuspicions(input).map((s) => s.normalizedName)).toEqual(['a', 'b']);
  });
});
