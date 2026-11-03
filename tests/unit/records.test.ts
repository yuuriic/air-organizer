import { describe, expect, it } from 'vitest';
import { inferKind, parseRows } from '../../src/core/records.js';
import type { RawRow } from '../../src/types/inventory.js';
import { row } from '../helpers.js';

const opts = { pageNumber: 2, observedAt: '2026-10-29T12:00:00.000Z' };

describe('parseRows', () => {
  it('mapeia as colunas observadas no AIR preservando o nome original', () => {
    const { items, issues } = parseRows(
      [row('OBSERVAÇÕES NOTURNAS', { description: 'Registros', path: '/Setor Ficticio/OBSERVAÇÕES NOTURNAS', createdAt: '10/03/2023 14:22' })],
      opts,
    );
    expect(issues).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: 'OBSERVAÇÕES NOTURNAS',
      description: 'Registros',
      path: '/Setor Ficticio/OBSERVAÇÕES NOTURNAS',
      createdAt: '10/03/2023 14:22',
      status: 'Ativo',
      sourcePage: 2,
      rowIndex: 0,
      identityConfidence: 'path-and-metadata',
    });
    expect(items[0]?.id).toBeUndefined();
  });

  it('aceita variações de cabeçalho (acento/caixa)', () => {
    const raw: RawRow = { cells: { NOME: 'X', 'Data de Criação': '01/01/2020', descricao: 'd' }, kindHints: [], idCandidates: {} };
    const [item] = parseRows([raw], opts).items;
    expect(item).toMatchObject({ name: 'X', createdAt: '01/01/2020', description: 'd' });
  });

  it('ignora linhas sem nome registrando aviso', () => {
    const raw: RawRow = { cells: { Nome: '  ' }, kindHints: [], idCandidates: {} };
    const result = parseRows([raw], opts);
    expect(result.items).toEqual([]);
    expect(result.issues[0]?.kind).toBe('parse-warning');
  });

  it('não usa atributos de ID sem validação explícita', () => {
    const raw: RawRow = { ...row('A'), idCandidates: { 'data-row-id': '42' } };
    expect(parseRows([raw], opts).items[0]?.id).toBeUndefined();
    const trusted = parseRows([raw], { ...opts, trustedIdAttribute: 'data-row-id' }).items[0];
    expect(trusted).toMatchObject({ id: '42', identityConfidence: 'stable-id', observationKey: 'id:42' });
  });

  it('marca identidade ambígua quando só há nome', () => {
    const raw: RawRow = { cells: { Nome: 'A' }, kindHints: [], idCandidates: {} };
    expect(parseRows([raw], opts).items[0]?.identityConfidence).toBe('ambiguous');
  });

  it('homônimos idênticos na mesma página recebem chaves distintas', () => {
    const { items } = parseRows([row('Cometas'), row('Cometas')], opts);
    expect(items).toHaveLength(2);
    expect(items[0]?.observationKey).not.toBe(items[1]?.observationKey);
  });

  it('a mesma linha em páginas diferentes gera a mesma chave (repetição detectável)', () => {
    const a = parseRows([row('A')], { ...opts, pageNumber: 1 }).items[0];
    const b = parseRows([row('A')], { ...opts, pageNumber: 2 }).items[0];
    expect(a?.observationKey).toBe(b?.observationKey);
  });

  it('nomes iguais com metadados diferentes geram chaves diferentes', () => {
    const a = parseRows([row('A', { createdAt: '01/01/2020' })], opts).items[0];
    const b = parseRows([row('A', { createdAt: '02/01/2020' })], opts).items[0];
    expect(a?.observationKey).not.toBe(b?.observationKey);
  });
});

describe('inferKind', () => {
  it('reconhece pasta e arquivo por pistas inequívocas', () => {
    expect(inferKind(row('x', {}, ['class=lucide lucide-folder']))).toBe('folder');
    expect(inferKind(row('x', {}, ['aria-label=Pasta']))).toBe('folder');
    expect(inferKind(row('x', {}, ['class=lucide lucide-file-text']))).toBe('file');
    expect(inferKind(row('x'), 'Arquivo')).toBe('file');
  });

  it('retorna unknown sem pista ou com pistas conflitantes', () => {
    expect(inferKind(row('relatorio.pdf'))).toBe('unknown');
    expect(inferKind(row('x', {}, ['class=lucide-folder', 'title=arquivo']))).toBe('unknown');
  });
});
