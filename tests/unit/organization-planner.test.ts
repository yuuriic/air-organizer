import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckpointFolder } from '../../src/core/checkpoint.js';
import { INTEGRITY_MESSAGES, sealInventory } from '../../src/core/inventory-integrity.js';
import { formatProposal, planOrganization, planningBasisProblems, redactPlan, type OrganizationPlan } from '../../src/core/organization-planner.js';
import { scanTree } from '../../src/core/tree-scanner.js';
import { treeInventoryDocument } from '../../src/storage/export.js';
import { inventoryAuthenticator } from '../../src/storage/integrity-key.js';
import { exportOrganizationPlan } from '../../src/storage/inventory-files.js';
import type { AirEnvironment, ResumeMode, TreeInventoryExport, TreeLimits } from '../../src/types/inventory.js';
import { SimNavigator, file, files, folder, type SimBehavior, type SimNode } from '../sim-navigator.js';

/**
 * Inventários inteiramente SINTÉTICOS (nomes fictícios, domínio .test, chave fixa de teste),
 * gerados pela leitura recursiva real sobre o simulador e selados como nas opções 6/7.
 */
const WIDE: TreeLimits = { maxDepth: 10, maxFolders: 200, maxItems: 10_000, maxPagesPerFolder: 50 };
const FINISHED = '2026-11-03T10:05:00.000Z';
const NOW = new Date('2026-11-03T12:00:00.000Z');
const AUTH = inventoryAuthenticator(Buffer.alloc(32, 7));
const ENV: AirEnvironment = {
  instanceOrigin: { status: 'identified', value: 'https://air.sigiloso.test', source: 'url' },
  pageUrl: { status: 'identified', value: 'https://air.sigiloso.test/air/my-air/raiz', source: 'url' },
  client: { status: 'identified', value: 'Cliente Sigiloso', source: 'operator' },
  sector: { status: 'identified', value: 'Setor Sigiloso', source: 'operator' },
  currentFolder: { status: 'identified', value: 'BELTRANA DE TAL', source: 'page-heading' },
  breadcrumb: { status: 'not-identified', reason: 'x' },
  observedAt: FINISHED,
};
const pseudonymize = (v: string) => createHmac('sha256', 'k').update(v).digest('hex').slice(0, 32);

type Opts = { homonyms?: 'refuse' | 'identify-by-url'; behavior?: SimBehavior; limits?: TreeLimits; resume?: { from: CheckpointFolder[]; mode: ResumeMode }; seal?: boolean; runId?: string; env?: AirEnvironment };
async function inventory(root: SimNode, opts: Opts = {}): Promise<{ doc: TreeInventoryExport; checkpoint: CheckpointFolder[] }> {
  let checkpoint: CheckpointFolder[] = [];
  const result = await scanTree(new SimNavigator(root, opts.behavior), opts.limits ?? WIDE, {
    checkpoint: { pseudonymize, save: async (s) => void (checkpoint = s.folders), resume: opts.resume },
    ...(opts.homonyms ? { homonyms: opts.homonyms } : {}),
  });
  const plain = treeInventoryDocument(result, { runId: opts.runId ?? 'run-sintetico', startedAt: '2026-11-03T10:00:00.000Z', finishedAt: FINISHED, environment: opts.env ?? ENV });
  const doc = opts.seal === false ? plain : sealInventory(plain, AUTH, new Date(FINISHED));
  return { doc: JSON.parse(JSON.stringify(doc)) as TreeInventoryExport, checkpoint }; // como lido do disco
}
const reseal = (d: TreeInventoryExport) => JSON.parse(JSON.stringify(sealInventory(d, AUTH, new Date(FINISHED)))) as TreeInventoryExport;
const plan = (doc: unknown, opts: { now?: Date; auth?: typeof AUTH | null } = {}) =>
  planOrganization(doc, { now: opts.now ?? NOW, ...(opts.auth === null ? {} : { authenticator: opts.auth ?? AUTH }) });

/**
 * Árvore com os padrões que geram as quatro categorias de proposta, toda lida e completa. As
 * homônimas exatas só são lidas com `homonyms: 'identify-by-url'` (ainda não habilitado na CLI).
 */
const richTree = () =>
  folder('raiz', 'BELTRANA DE TAL', [
    // Homônimas no mesmo pai, com conteúdos diferentes (abertas e identificadas pela URL).
    folder('h1', 'Fulano 111.222.333-44', files('a', 3)),
    folder('h2', 'Fulano 111.222.333-44', [folder('hx', 'Outro'), file('b')]),
    // Irmãs equivalentes por caixa, com conteúdos diferentes.
    folder('o1', 'ORBITAS', files('c', 1)),
    folder('o2', 'Orbitas', [file('d'), file('e')]),
    // Mesmo nome em pais diferentes, com hierarquias diferentes; 2 de 3 grafias iguais.
    folder('al', 'Alfa', [folder('p1', 'Planetas', [folder('s1', 'Mercurio'), folder('s2', 'Venus'), folder('s3', 'Terra')])]),
    folder('be', 'Beta', [folder('p2', 'Planetas', [folder('t1', 'Mercurio'), folder('t2', 'Venus'), folder('t3', 'Marte')])]),
    folder('ga', 'Gama', [folder('p3', 'PLANETAS')]),
    // Mesmo nome repetido em níveis seguidos.
    folder('n1', 'Contratos', [folder('n2', 'Contratos')]),
  ]);
/** Inventário da árvore acima, como lido do disco (selado por padrão). */
const rich = async (opts: Opts = {}): Promise<TreeInventoryExport> => (await inventory(richTree(), { homonyms: 'identify-by-url', ...opts })).doc;

const SENSITIVE = ['BELTRANA', 'Fulano', '111.222', 'Planetas', 'PLANETAS', 'ORBITAS', 'Orbitas', 'Mercurio', 'Contratos', 'sigiloso', 'Sigiloso', 'run-sintetico', '"name"', '"path"', '"hypothesisName"'];

function walk(value: unknown, visit: (key: string, v: unknown) => void): void {
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) (visit(k, v), walk(v, visit));
}

describe('inventário válido e elegível', () => {
  it('gera propostas pendentes, não executáveis, ligadas ao inventário autenticado', async () => {
    const doc = await rich();
    const p = plan(doc);
    expect(p.validation).toMatchObject({ status: 'accepted', integrity: { status: 'authenticated' }, eligibility: { status: 'planning-eligible' }, basisProblems: [], reasons: [] });
    expect(p).toMatchObject({ kind: 'air-organizer/organization-plan', schemaVersion: 1, executable: false, authorizesChanges: false, authenticated: false, identifiable: true });
    expect(p.source).toEqual({ runId: 'run-sintetico', finishedAt: FINISHED, sealedAt: FINISHED, inventoryId: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(p.proposals.length).toBeGreaterThanOrEqual(5);
    for (const x of p.proposals) {
      expect(x).toMatchObject({ status: 'pending-review', executable: false });
      expect(x.id).toMatch(/^P-[0-9a-f]{16}$/);
      expect(x.observed.findingIds.length).toBeGreaterThan(0);
      expect(['high', 'medium', 'low']).toContain(x.confidence.level);
      expect(x.confidence.basis.length).toBeGreaterThan(0);
      expect(x.risks.length).toBeGreaterThan(0);
      if (x.futureAction) expect(x.futureAction).toMatchObject({ executable: false, authorizesChanges: false });
    }
    expect(p.summary.byKind).toEqual({ 'review-equivalent-names': 2, 'review-naming-inconsistency': 0, 'review-standardization': 1, 'review-divergent-hierarchy': 2 });
    expect(p.notices.join(' ')).toMatch(/não é autenticado/);
    expect(p.notices.join(' ')).toMatch(/não é probabilidade nem autorização/);
  });

  it('separa diagnóstico observado, proposta, possível ação futura e impedimentos/riscos', async () => {
    const p = plan((await rich()));
    for (const x of p.proposals) expect(Object.keys(x)).toEqual(expect.arrayContaining(['observed', 'proposal', 'confidence', 'blockers', 'risks']));
    const withFuture = p.proposals.filter((x) => x.futureAction);
    expect(withFuture.map((x) => x.futureAction!.kind).sort()).toEqual(['consolidation-review', 'consolidation-review', 'name-standardization-review']);
  });
});

describe('inventários inelegíveis: recusa, sem propostas', () => {
  const expectRefused = (p: OrganizationPlan) => {
    expect(p.validation.status).toBe('refused');
    expect(p.proposals).toEqual([]);
    expect(p.observed).toBeUndefined();
    expect(p.source).toEqual({});
    expect(p.summary.proposals).toBe(0);
  };

  it('adulterado (selo não confere): recusado', async () => {
    const doc = await rich();
    const p = plan({ ...doc, environment: { ...doc.environment, sector: { status: 'identified', value: 'Outro Setor', source: 'operator' } } });
    expectRefused(p);
    expect(p.validation.integrity).toEqual({ status: 'invalid', reason: 'mac-mismatch' });
    expect(p.validation.reasons).toEqual([`integridade: ${INTEGRITY_MESSAGES['mac-mismatch']}`]);
  });

  it('sem selo (legado ou selo removido): recusado', async () => {
    const legacy = plan((await rich({ seal: false })));
    const { integrity: _removed, ...stripped } = await rich();
    for (const p of [legacy, plan(stripped)]) {
      expectRefused(p);
      expect(p.validation.reasons).toEqual(['integrity-unsigned']);
    }
  });

  it('sem chave local para verificar (não verificável): recusado', async () => {
    const p = plan((await rich()), { auth: null });
    expectRefused(p);
    expect(p.validation.reasons).toEqual(['integrity-unverifiable']);
  });

  it('chave local diferente: recusado', async () => {
    const p = plan((await rich()), { auth: inventoryAuthenticator(Buffer.alloc(32, 9)) });
    expectRefused(p);
    expect(p.validation.integrity).toEqual({ status: 'invalid', reason: 'key-mismatch' });
  });

  it('FAST (autenticado): recusado', async () => {
    const first = await inventory(richTree(), { behavior: { lose: ['ga'] }, seal: false });
    const p = plan((await inventory(richTree(), { resume: { from: first.checkpoint, mode: 'fast' } })).doc);
    expectRefused(p);
    expect(p.validation.reasons).toEqual(expect.arrayContaining(['fast-resume', 'reused-folders', 'not-eligible-for-planning']));
    expect(p.validation.basisProblems.join(' ')).toMatch(/reaproveitada|retomada não VERIFICADA/);
  });

  it('parcial (autenticado): recusado', async () => {
    const p = plan((await rich({ limits: { ...WIDE, maxFolders: 3 } })));
    expectRefused(p);
    expect(p.validation.reasons).toEqual(expect.arrayContaining(['status-partial']));
  });

  it('expirado (autenticado e completo): recusado', async () => {
    const p = plan((await rich()), { now: new Date('2026-11-20T00:00:00.000Z') });
    expectRefused(p);
    expect(p.validation.reasons).toEqual(['stale']);
  });

  it('referências inconsistentes (mesmo com selo válido): recusado, sem expor o conteúdo das referências', async () => {
    const doc = await rich({ seal: false });
    const dangling = reseal({ ...doc, folders: doc.folders.map((f, i) => (i === 3 ? { ...f, parentRef: 'F99' } : f)) });
    const leaking = reseal({ ...doc, folders: doc.folders.map((f, i) => (i === 3 ? { ...f, ref: 'Fulano 111.222.333-44' } : f)) });
    for (const d of [dangling, leaking]) {
      const p = plan(d);
      expectRefused(p);
      expect(p.validation.integrity.status).toBe('authenticated'); // íntegro, porém inconsistente
      expect(p.validation.eligibility.status).toBe('rejected');
      expect(JSON.stringify(p)).not.toMatch(/Fulano|111\.222/);
    }
  });

  it('a completude é conferida nas pastas, sem confiar nas flags gravadas', async () => {
    const doc = await rich({ seal: false });
    expect(planningBasisProblems(doc)).toEqual([]);
    // Flags dizem "elegível", mas as pastas contam outra história.
    const forged = { ...doc, verification: { contentRevalidated: true, eligibleForPlanning: true } };
    expect(planningBasisProblems({ ...forged, folders: forged.folders.map((f, i) => (i === 2 ? { ...f, reusedFrom: FINISHED } : f)) })).toEqual(['1 pasta(s) reaproveitada(s) sem releitura']);
    expect(planningBasisProblems({ ...forged, folders: forged.folders.map((f, i) => (i === 2 ? { ...f, status: 'partial' as const } : f)) })).toEqual(['1 pasta(s) sem leitura completa']);
    expect(planningBasisProblems({ ...forged, navigation: { ...forged.navigation!, contentChanged: 1 } })).toHaveLength(1);
    expect(planningBasisProblems({ ...forged, limitsReached: ['max-folders'] })).toHaveLength(1);
  });
});

describe('regras conservadoras', () => {
  it('homônimas exatas na política padrão (não abertas): inventário parcial, plano recusado', async () => {
    const root = folder('raiz', 'Raiz', [folder('h1', 'Fulano 111.222.333-44', files('a', 3)), folder('h2', 'Fulano 111.222.333-44', [file('b')]), folder('o1', 'ORBITAS'), folder('o2', 'Orbitas')]);
    const p = plan((await inventory(root)).doc);
    expect(p.validation.status).toBe('refused');
    expect(p.validation.reasons).toEqual(expect.arrayContaining(['status-partial', 'completude: 2 pasta(s) com pendência']));
    expect(JSON.stringify(p)).not.toMatch(/Fulano|ORBITAS/);
  });

  it('homônimas lidas e identificadas pela URL: inventário completo, propostas de revisão', async () => {
    const root = folder('raiz', 'Raiz', [folder('h1', 'Fulano 111.222.333-44', files('a', 3)), folder('h2', 'Fulano 111.222.333-44', [file('b')]), folder('o1', 'ORBITAS'), folder('o2', 'Orbitas')]);
    const p = plan((await inventory(root, { homonyms: 'identify-by-url' })).doc);
    expect(p.validation.status).toBe('accepted');
    expect(p.proposals.map((x) => [x.observed.rules[0], x.kind])).toEqual([
      ['DUP-SIBLING-EXACT', 'review-equivalent-names'],
      ['DUP-SIBLING-NORMALIZED', 'review-equivalent-names'],
    ]);
    expect(JSON.stringify(redactPlan(p))).not.toMatch(/Fulano|ORBITAS/);
  });

  it('homônimas em que duas linhas levam à mesma pasta: identidade ambígua, plano recusado', async () => {
    const root = folder('raiz', 'Raiz', [folder('h1', 'Docs', files('a', 1)), folder('h2', 'Docs', [file('b')])]);
    const p = plan((await inventory(root, { homonyms: 'identify-by-url', behavior: { redirect: { h2: 'h1' } } })).doc);
    expect(p.validation.status).toBe('refused');
    expect(p.validation.reasons).toEqual(expect.arrayContaining(['status-partial']));
  });

  it('homônimas lidas, com conteúdos diferentes: só revisão; nunca presume conteúdo igual nem fusão', async () => {
    const p = plan(await rich());
    const homonyms = p.proposals.find((x) => x.observed.rules[0] === 'DUP-SIBLING-EXACT')!;
    expect(homonyms).toMatchObject({ kind: 'review-equivalent-names', confidence: { level: 'high' } });
    expect(homonyms.observed.folders.slice(1).map((e) => e.counts)).toEqual([{ items: 3, folders: 0, files: 3 }, { items: 2, folders: 1, files: 1 }]);
    expect(homonyms.blockers.join(' ')).toMatch(/nome equivalente não indica conteúdo equivalente/);
    expect(homonyms.futureAction).toMatchObject({ kind: 'consolidation-review', executable: false });
    const text = JSON.stringify(p.proposals.map(({ proposal, futureAction, blockers, risks }) => ({ proposal, futureAction, blockers, risks })));
    // "conteúdo equivalente/igual" só aparece negado.
    const mentions = text.match(/[^.]{0,30}conteúdo (é |são )?(igual|idêntico|equivalente)/gi) ?? [];
    for (const m of mentions) expect(m).toMatch(/não (indica|implica)/);
    expect(text).not.toMatch(/\b(excluir|apagar|deletar|mesclar automaticamente)\b/i);
  });

  it('irmãs equivalentes abertas: hipótese de consolidação NÃO executável, sem origem nem destino', async () => {
    const p = plan((await rich()));
    const eq = p.proposals.find((x) => x.observed.rules[0] === 'DUP-SIBLING-NORMALIZED')!;
    expect(eq.confidence.level).toBe('medium');
    expect(eq.futureAction).toMatchObject({ kind: 'consolidation-review', executable: false, authorizesChanges: false });
    expect(eq.futureAction!.preconditions.join(' ')).toMatch(/Escolha explícita da pasta principal; o plano não indica origem nem destino/);
    expect(eq.futureAction!.preconditions.join(' ')).toMatch(/nunca entre setores/);
    expect(eq.blockers.join(' ')).toMatch(/não foi comparado/);
  });

  it('nomes equivalentes com hierarquias diferentes: revisão de hierarquia, sem ação futura', async () => {
    const p = plan((await rich()));
    const hier = p.proposals.find((x) => x.observed.rules[0] === 'HIER-EQUIVALENT-CHILDREN')!;
    expect(hier).toMatchObject({ kind: 'review-divergent-hierarchy', confidence: { level: 'low' } }); // 2 de 4 em comum
    expect(hier.futureAction).toBeUndefined();
    expect(hier.blockers.join(' ')).toMatch(/Mesmo nome não implica conteúdo equivalente/);
    expect(hier.blockers.join(' ')).toMatch(/nenhuma pasta é criada, movida ou mesclada/);
    const nested = p.proposals.find((x) => x.observed.rules[0] === 'HIER-NESTED-SAME-NAME')!;
    expect(nested.futureAction).toBeUndefined();
  });

  it('grafia predominante é só hipótese; sem maioria estrita, nenhuma hipótese', async () => {
    const p = plan((await rich()));
    const std = p.proposals.find((x) => x.kind === 'review-standardization')!;
    expect(std.futureAction).toMatchObject({ kind: 'name-standardization-review', hypothesisName: 'Planetas', executable: false });
    expect(std.futureAction!.hypothesis).toMatch(/2 de 3 ocorrências.*HIPÓTESE.*não é regra oficial/);

    const tie = folder('raiz', 'Raiz', [folder('a', 'Alfa', [folder('a1', 'Orbitas')]), folder('b', 'Beta', [folder('b1', 'ÓRBITAS')])]);
    const [naming] = plan((await inventory(tie)).doc).proposals;
    expect(naming).toMatchObject({ kind: 'review-naming-inconsistency' });
    expect(naming!.futureAction).toBeUndefined();
    expect(naming!.blockers.join(' ')).toMatch(/Nenhuma grafia tem maioria/);
  });

  it('setor não identificado: nenhuma ação futura, com impedimento explícito', async () => {
    const env = { ...ENV, sector: { status: 'not-identified' as const, reason: 'x' } };
    const p = plan((await rich({ env })));
    expect(p.validation.status).toBe('accepted');
    expect(p.proposals.filter((x) => x.futureAction)).toEqual([]);
    expect(p.proposals.some((x) => x.blockers.some((b) => /Setor não identificado/.test(b)))).toBe(true);
  });
});

describe('regras operacionais confirmadas', () => {
  it('variações de caixa e acento: categoria só com confirmação; hierarquia e grafias preservadas; sem destino', async () => {
    const root = folder('raiz', 'Raiz', [folder('o1', 'oficio circular', files('a', 1)), folder('o2', 'OFICIO CIRCULAR', files('b', 1)), folder('o3', 'ofício circular')]);
    const [p, ...others] = plan((await inventory(root)).doc).proposals;
    expect(others).toEqual([]);
    expect(p).toMatchObject({ kind: 'review-equivalent-names', status: 'pending-review', executable: false, futureAction: { kind: 'consolidation-review', executable: false } });
    expect(p!.observed.folders.map((f) => f.path)).toEqual(['/Raiz', '/Raiz/oficio circular', '/Raiz/OFICIO CIRCULAR', '/Raiz/ofício circular']);
    expect(new Set(p!.observed.folders.slice(1).map((f) => f.parentRef))).toEqual(new Set([p!.observed.folders[0]!.ref]));
    expect(p!.futureAction!.hypothesisName).toBeUndefined();
    expect(p!.futureAction!.preconditions.join(' ')).toMatch(/Confirmação, por uma pessoa/);
  });

  it('o plano não exige comparar o conteúdo interno dos arquivos (o operador não o faz)', async () => {
    const text = JSON.stringify(plan(await rich()).proposals.flatMap((x) => [...x.proposal.reviewQuestions, ...(x.futureAction?.preconditions ?? [])]));
    expect(text).not.toMatch(/compara\S* (d[oe] )?conteúdo|conteúdo .{0,30}conferido/i);
  });

  it('arquivos com o mesmo nome e subpasta 2025 dos dois lados: nenhuma proposta, igualdade nem destino presumidos', async () => {
    const doc = () => file('p', 'PROCESSO_00000_2031.pdf');
    const root = folder('raiz', 'Raiz', [folder('or', 'Origem', [folder('a', '2025', [doc()]), doc()]), folder('de', 'Destino', [folder('b', '2025', [doc()])])]);
    const p = plan((await inventory(root)).doc);
    expect(p.validation.status).toBe('accepted');
    expect(p.proposals).toEqual([]);
    expect(JSON.stringify(p)).not.toContain('PROCESSO');
  });
});

describe('determinismo e identidade', () => {
  it('mesmo inventário + mesmo now = mesmo plano, byte a byte; IDs não dependem de now', async () => {
    const doc = await rich();
    expect(JSON.stringify(plan(doc))).toBe(JSON.stringify(plan(structuredClone(doc))));
    const later = plan(doc, { now: new Date('2026-11-04T09:00:00.000Z') });
    expect(later.proposals.map((x) => x.id)).toEqual(plan(doc).proposals.map((x) => x.id));
  });

  it('IDs incorporam a identidade do inventário autenticado: outra leitura, outros IDs', async () => {
    const a = plan((await rich()));
    const b = plan((await rich({ runId: 'run-outra' })));
    expect(a.proposals.map((x) => x.observed.findingIds)).toEqual(b.proposals.map((x) => x.observed.findingIds)); // mesmos achados
    expect(a.source.inventoryId).not.toBe(b.source.inventoryId);
    for (const [i, x] of a.proposals.entries()) expect(x.id).not.toBe(b.proposals[i]!.id);
    expect(new Set(a.proposals.map((x) => x.id)).size).toBe(a.proposals.length); // únicos
  });
});

describe('privacidade e ausência de operações executáveis', () => {
  it('plano sem nomes e linhas de console não expõem nomes, contexto, runId, selo nem chave', async () => {
    const doc = await rich();
    const p = plan(doc);
    const exposed = JSON.stringify(redactPlan(p)) + p.proposals.map(formatProposal).join('\n') + plan({ ...doc, runId: 'x' }).validation.reasons.join(';');
    for (const s of [...SENSITIVE, doc.integrity!.mac, AUTH.keyId, AUTH.mac('probe').toString('hex')]) expect(exposed).not.toContain(s);
    expect(redactPlan(p).identifiable).toBe(false);
    expect(JSON.stringify(p)).not.toContain(doc.integrity!.mac); // nem o detalhado guarda o código do selo
  });

  it('nenhuma operação, comando, destino ou URL no plano (detalhado ou não); tudo não executável', async () => {
    const p = plan((await rich()));
    const FORBIDDEN = /^(operations?|commands?|steps|script|target|targets|destination|destinations|from|to|source(Ref|Folder)|move|moves|rename|merge|delete|url|pageUrl|href|selector|execute)$/i;
    for (const doc of [p, redactPlan(p)]) {
      walk(doc, (k, v) => {
        expect(k).not.toMatch(FORBIDDEN);
        if (k === 'executable' || k === 'authorizesChanges') expect(v).toBe(false);
        if (typeof v === 'string') expect(v).not.toMatch(/^https?:\/\//);
      });
    }
  });

  it('o motor não depende de navegador, rede, processos nem sistema de arquivos', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/core/organization-planner.ts'), 'utf-8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../types/inventory.js', './inventory-integrity.js', './structural-diagnostics.js', 'node:crypto']);
  });
});

describe('exportação local', () => {
  it('grava o plano sem nomes ao lado do inventário; o detalhado só quando pedido; recusado não é gravado', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-plan-'));
    try {
      const inventoryFile = path.join(dir, 'inst', 'setor', 'run', 'tree-inventory.json');
      const p = plan((await rich()));
      const [redacted] = await exportOrganizationPlan(p, inventoryFile, { detailed: false }, dir);
      expect(path.basename(redacted!)).toBe('organization-plan.json');
      expect(await readdir(path.dirname(inventoryFile))).toEqual(['organization-plan.json']);
      const text = await readFile(redacted!, 'utf-8');
      for (const s of SENSITIVE) expect(text).not.toContain(s);
      const written = await exportOrganizationPlan(p, inventoryFile, { detailed: true }, dir);
      expect(written.map((f) => path.basename(f))).toEqual(['organization-plan.json', 'organization-plan-detailed.json']);

      const refused = plan((await rich({ seal: false })));
      const other = path.join(dir, 'inst', 'setor', 'run-2', 'tree-inventory.json');
      await expect(exportOrganizationPlan(refused, other, { detailed: true }, dir)).rejects.toThrow(/recusado/);
      expect(existsSync(path.dirname(other))).toBe(false);
      await expect(exportOrganizationPlan(p, path.join(dir, '..', 'fora', 'tree-inventory.json'), { detailed: false }, dir)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('os planos ficam em diretório ignorado pelo Git', async () => {
    const ignore = await readFile(path.join(process.cwd(), '.gitignore'), 'utf-8');
    expect(ignore).toMatch(/^output\/$/m);
    expect(ignore).toMatch(/^organization-plan\*\.json$/m);
  });
});
