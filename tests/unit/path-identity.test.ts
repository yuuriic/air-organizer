import { describe, expect, it } from 'vitest';
import { FolderIdentityError, pathCandidates, verifyChildIdentity, type FolderContext } from '../../src/air/folders.js';

/** Dados SINTÉTICOS. Identidade, caminho da pasta e "Caminho" de cada linha são coisas distintas. */
const CRUMBS = ['Setor', '…', 'Nivel2'];
const OWN = '/Setor/Nivel1/Nivel2';

describe('pathCandidates: caminho da pasta inicial com breadcrumb colapsado', () => {
  it('candidato único coerente com título e breadcrumb; item de outro ramo não é candidato', () => {
    expect(pathCandidates([OWN, OWN, '/Setor/Outro', OWN], 'Nivel2', CRUMBS)).toEqual([OWN]);
  });

  it('dois caminhos igualmente compatíveis (ramo vizinho com pasta de mesmo nome): os dois, para recusa', () => {
    expect(pathCandidates([OWN, '/Setor/Outro/Nivel2'], 'Nivel2', CRUMBS)).toEqual([OWN, '/Setor/Outro/Nivel2']);
  });

  it('nenhum candidato', () => {
    expect(pathCandidates(['/Setor/P', '/Setor/Q'], 'Nivel2', CRUMBS)).toEqual([]);
  });

  it.each([
    ['vazio', ''],
    ['sem barra inicial', 'Setor/Nivel1/Nivel2'],
    ['segmento vazio', '/Setor//Nivel2'],
    ['último segmento só equivalente (caixa)', '/Setor/Nivel1/nivel2'],
    ['último segmento só equivalente (acento)', '/Setor/Nivel1/Nível2'],
    ['sem nível oculto para o "…"', '/Setor/Nivel2'],
    ['outra raiz', '/Outro/Nivel1/Nivel2'],
  ])('não é candidato: %s', (_, p) => {
    expect(pathCandidates([p], 'Nivel2', CRUMBS)).toEqual([]);
  });

  it('não depende de ordem, posição nem repetição (sem maioria)', () => {
    const rows = ['/Setor/Outro', '/Setor/Outro', '/Setor/Outro', OWN];
    expect(pathCandidates(rows, 'Nivel2', CRUMBS)).toEqual([OWN]);
    expect(pathCandidates([...rows].reverse(), 'Nivel2', CRUMBS)).toEqual([OWN]);
  });
});

describe('caminho inferido não é prova independente de identidade', () => {
  const ctx = (o: Partial<FolderContext>): FolderContext => ({ pageUrl: 'https://air.test/air/my-air/P', title: 'Nivel2', total: 1, rows: 1, signature: 's', environment: {} as FolderContext['environment'], ...o });
  const inferred = ctx({ path: OWN, pathEvidence: 'inferred', breadcrumb: CRUMBS });
  const known = ctx({ path: OWN, pathEvidence: 'expected', breadcrumb: CRUMBS });
  const target = { name: 'Sub', rowIndex: 0, expectedPath: `${OWN}/Sub` };
  const child = ctx({ pageUrl: 'https://air.test/air/my-air/C', title: 'Sub', breadcrumb: ['Setor', '…', 'Sub'], path: `${OWN}/Sub`, pathEvidence: 'expected' });

  it('com pai inferido, o caminho confere mas não entra nas evidências (URL, título e breadcrumb bastam)', () => {
    expect(verifyChildIdentity(known, target, child)).toHaveLength(4);
    const evidence = verifyChildIdentity(inferred, target, child);
    expect(evidence).toHaveLength(3);
    expect(evidence.join(' ')).not.toMatch(/caminho =/);
  });

  it('com pai inferido, caminho divergente continua recusando', () => {
    expect(() => verifyChildIdentity(inferred, target, { ...child, path: `${OWN}/Outra` })).toThrow(expect.objectContaining({ code: 'path-mismatch' }));
  });

  it('com pai inferido e sem breadcrumb na subpasta, o caminho não completa o mínimo: evidência insuficiente', () => {
    const { breadcrumb: _b, ...noCrumbs } = child;
    expect(verifyChildIdentity(known, target, noCrumbs)).toHaveLength(3);
    expect(() => verifyChildIdentity(inferred, target, noCrumbs)).toThrow(FolderIdentityError);
    expect(() => verifyChildIdentity(inferred, target, noCrumbs)).toThrow(expect.objectContaining({ code: 'insufficient-evidence' }));
  });

  it('título e URL continuam obrigatórios com pai inferido', () => {
    expect(() => verifyChildIdentity(inferred, target, { ...child, title: 'Outra' })).toThrow(expect.objectContaining({ code: 'title-mismatch' }));
    expect(() => verifyChildIdentity(inferred, target, { ...child, pageUrl: inferred.pageUrl })).toThrow(expect.objectContaining({ code: 'url-unchanged' }));
  });
});
