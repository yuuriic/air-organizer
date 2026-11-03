import { describe, expect, it } from 'vitest';
import { FolderIdentityError, breadcrumbMatches, verifyChildIdentity, type FolderContext } from '../../src/air/folders.js';
import { classifyRow } from '../../src/core/records.js';
import { scanListing } from '../../src/core/scanner.js';
import { SafetyViolation, assertFolderOpenTarget, assertParentLinkTarget, type FolderOpenTarget } from '../../src/safety/scope-validator.js';
import { pageOf, row, simulatedSource } from '../helpers.js';

function ctx(overrides: Partial<FolderContext>): FolderContext {
  return { pageUrl: 'https://air.test/air/my-air/A', title: 'Pai', total: 1, rows: 1, signature: 's', environment: {} as FolderContext['environment'], ...overrides };
}

describe('assertFolderOpenTarget', () => {
  const ok: FolderOpenTarget = { expectedName: 'Sub', rowName: 'Sub', cellText: 'Sub', kind: 'folder', sameNameRows: 1, interactiveInCell: 0 };

  it('aceita linha de pasta com nome único e célula sem controles', () => {
    expect(() => assertFolderOpenTarget(ok)).not.toThrow();
    expect(() => assertFolderOpenTarget({ ...ok, expectedName: 'Excluir antigos', rowName: 'Excluir antigos', cellText: 'Excluir antigos' })).not.toThrow();
  });

  it.each<[string, Partial<FolderOpenTarget>]>([
    ['arquivo', { kind: 'file' }],
    ['tipo desconhecido', { kind: 'unknown' }],
    ['linha trocada', { rowName: 'Outra' }],
    ['texto da célula diferente', { cellText: 'Sub 2' }],
    ['homônimo na página', { sameNameRows: 2 }],
    ['controle na célula', { interactiveInCell: 1 }],
  ])('recusa: %s', (_, change) => {
    expect(() => assertFolderOpenTarget({ ...ok, ...change })).toThrow(SafetyViolation);
  });
});

describe('assertParentLinkTarget', () => {
  const ok = { expectedParent: 'Meu Air', expectedCurrent: 'Sub', currentText: 'Sub', currentIsCurrentPage: true, linkCount: 1, linkText: 'Meu Air' };
  it('aceita só o link imediatamente anterior ao item atual', () => {
    expect(() => assertParentLinkTarget(ok)).not.toThrow();
    expect(() => assertParentLinkTarget({ ...ok, linkText: 'Outra' })).toThrow(SafetyViolation);
    expect(() => assertParentLinkTarget({ ...ok, linkCount: 0 })).toThrow(SafetyViolation);
    expect(() => assertParentLinkTarget({ ...ok, currentIsCurrentPage: false })).toThrow(SafetyViolation);
    expect(() => assertParentLinkTarget({ ...ok, currentText: 'Outra' })).toThrow(SafetyViolation);
  });
});

describe('breadcrumbMatches', () => {
  const full = ['Meu Air', 'Setor Exemplo - Unidade Alfa', 'lote beta', 'Sub'];
  it('exige igualdade sem colapso e aceita "…" cobrindo 1+ ancestrais ocultos', () => {
    expect(breadcrumbMatches(full, full)).toBe(true);
    expect(breadcrumbMatches(['Meu Air', '…', 'Sub'], full)).toBe(true);
    expect(breadcrumbMatches(['Meu Air', '…', 'lote beta', 'Sub'], full)).toBe(true);
  });
  it.each([
    [['Meu Air', '…', 'Outra'], 'fim diferente'],
    [['Outro', '…', 'Sub'], 'início diferente'],
    [['Meu Air', 'Setor Exemplo - Unidade Alfa', 'lote beta', '…', 'Sub'], '"…" sem ancestral oculto'],
    [['Meu Air', '…', '…', 'Sub'], 'dois colapsos'],
    [['Meu Air', 'Sub'], 'segmento faltando sem colapso'],
  ])('recusa %j (%s)', (observed) => {
    expect(breadcrumbMatches(observed, full)).toBe(false);
  });
});

describe('verifyChildIdentity', () => {
  const parent = ctx({ title: 'Meu Air', path: '/Meu Air' });
  const target = { name: 'Sub', rowIndex: 0, expectedPath: '/Meu Air/Sub' };
  const child = ctx({ pageUrl: 'https://air.test/air/my-air/B', title: 'Sub', breadcrumb: ['Meu Air', 'Sub'], path: '/Meu Air/Sub' });

  it('confirma por URL, título, breadcrumb e caminho', () => {
    expect(verifyChildIdentity(parent, target, child)).toHaveLength(4);
  });

  it('cadeia esperada vem do caminho do pai, mesmo com o breadcrumb do pai colapsado', () => {
    const deepParent = ctx({ title: 'lote beta', path: '/Meu Air/Setor Exemplo - Unidade Alfa/lote beta', breadcrumb: ['Meu Air', '…', 'lote beta'] });
    const deepChild = ctx({ pageUrl: 'https://air.test/air/my-air/C', title: 'Sub', breadcrumb: ['Meu Air', '…', 'Sub'] });
    expect(verifyChildIdentity(deepParent, { name: 'Sub', rowIndex: 0 }, deepChild)).toContain('breadcrumb Meu Air / … / Sub ≅ Meu Air / Setor Exemplo - Unidade Alfa / lote beta / Sub');
  });

  it.each<[string, Partial<FolderContext>]>([
    ['URL igual à do pai', { pageUrl: parent.pageUrl }],
    ['título diferente', { title: 'Outra' }],
    ['breadcrumb de outro ramo', { breadcrumb: ['Meu Air', 'X', 'Sub'] }],
    ['caminho diferente', { path: '/Meu Air/Outra' }],
    ['sem breadcrumb nem caminho', { breadcrumb: undefined, path: undefined }],
  ])('interrompe: %s', (_, change) => {
    expect(() => verifyChildIdentity(parent, target, { ...child, ...change })).toThrow(FolderIdentityError);
  });
});

describe('classifyRow com coluna de ícone', () => {
  it('decide só pelo ícone da coluna de tipo, por allowlist', () => {
    expect(classifyRow({ ...row('x'), typeIcon: 'folder' })).toEqual({ kind: 'folder', evidence: 'icon:folder' });
    expect(classifyRow({ ...row('x.pdf'), typeIcon: 'img:pdf icon' })).toEqual({ kind: 'file', evidence: 'icon:img:pdf icon' });
    // Ícone fora das regras e pistas do resto da linha (ex.: Status "file-search", aria-label "Pasta") não decidem.
    expect(classifyRow({ ...row('x', {}, ['aria-label=Pasta']), typeIcon: 'file-text' })).toEqual({ kind: 'unknown' });
    expect(classifyRow({ ...row('x', {}, ['class=lucide lucide-file-search']), typeIcon: '' })).toEqual({ kind: 'unknown' });
    expect(classifyRow({ ...row('pasta.pdf'), typeIcon: 'img:avatar' })).toEqual({ kind: 'unknown' });
    expect(classifyRow({ ...row('x'), typeIcon: 'img:' })).toEqual({ kind: 'unknown' });
  });
});

describe('scanListing — filtros', () => {
  const options = { maxPages: 5, readTimeoutMs: 200 };
  it('filtro "Todos" e busca vazia não geram problema', async () => {
    const { coverage } = await scanListing(simulatedSource([{ ...pageOf(['A'], 1), typeFilter: 'Todos', searchActive: false }]), options);
    expect(coverage.complete).toBe(true);
  });

  it.each([{ typeFilter: 'Pastas' }, { typeFilter: 'Arquivos' }, { typeFilter: 'Todos', searchActive: true }])('marca parcial com %o', async (filter) => {
    const { coverage } = await scanListing(simulatedSource([{ ...pageOf(['A'], 1), ...filter }]), options);
    expect(coverage.complete).toBe(false);
    expect(coverage.issues.map((i) => i.kind)).toEqual(['filter-active']);
  });
});
