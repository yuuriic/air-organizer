import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckpointFolder } from '../../src/core/checkpoint.js';
import { INTEGRITY_MESSAGES, UNSIGNED_INVENTORY_MESSAGE, sealInventory, verifyInventoryIntegrity } from '../../src/core/inventory-integrity.js';
import { analyzeStructure, formatFinding, redactReport, validateInventory } from '../../src/core/structural-diagnostics.js';
import { scanTree } from '../../src/core/tree-scanner.js';
import { CheckpointStore } from '../../src/storage/checkpoints.js';
import { exportTreeResult, treeInventoryDocument } from '../../src/storage/export.js';
import { inventoryAuthenticator, openVerifyingAuthenticator } from '../../src/storage/integrity-key.js';
import { readInventory } from '../../src/storage/inventory-files.js';
import type { AirEnvironment, ResumeMode, TreeInventoryExport, TreeLimits } from '../../src/types/inventory.js';
import { SimNavigator, files, folder, type SimBehavior, type SimNode } from '../sim-navigator.js';

/** Tudo SINTÉTICO: chaves fixas de teste, nomes fictícios, domínio .test. */
const MASTER = Buffer.alloc(32, 7);
const AUTH = inventoryAuthenticator(MASTER);
const OTHER = inventoryAuthenticator(Buffer.alloc(32, 9));
const WIDE: TreeLimits = { maxDepth: 10, maxFolders: 200, maxItems: 10_000, maxPagesPerFolder: 50 };
const FINISHED = '2026-11-03T10:05:00.000Z';
const NOW = new Date('2026-11-03T12:00:00.000Z');
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
const tree = () =>
  folder('raiz', 'BELTRANA DE TAL', [
    folder('a', 'Alfa', [folder('a1', 'Fulano 111.222.333-44', files('x', 2))]),
    folder('b', 'Beta', [folder('b1', 'FULANO 111.222.333-44')]),
    folder('c', 'Gama'),
  ]);

type Doc = TreeInventoryExport & Record<string, unknown>;
async function scan(root: SimNode, opts: { behavior?: SimBehavior; limits?: TreeLimits; resume?: { from: CheckpointFolder[]; mode: ResumeMode } } = {}) {
  let checkpoint: CheckpointFolder[] = [];
  const result = await scanTree(new SimNavigator(root, opts.behavior), opts.limits ?? WIDE, {
    checkpoint: { pseudonymize, save: async (s) => void (checkpoint = s.folders), resume: opts.resume },
  });
  const plain = treeInventoryDocument(result, { runId: 'run-sintetico', startedAt: '2026-11-03T10:00:00.000Z', finishedAt: FINISHED, environment: ENV });
  return { plain, checkpoint };
}
/** Selado como nas opções 6/7 e lido "do disco". */
const sealed = async (root = tree(), opts?: Parameters<typeof scan>[1]): Promise<Doc> =>
  JSON.parse(JSON.stringify(sealInventory((await scan(root, opts)).plain, AUTH, new Date(FINISHED)))) as Doc;
const analyze = (doc: unknown, opts: { now?: Date; auth?: typeof AUTH | null } = {}) =>
  analyzeStructure(doc, { now: opts.now ?? NOW, ...(opts.auth === null ? {} : { authenticator: opts.auth ?? AUTH }) });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('inventário íntegro', () => {
  it('selado, completo, revalidado e recente: autenticado e elegível', async () => {
    const r = analyze(await sealed());
    expect(r.integrity).toEqual({ status: 'authenticated' });
    expect(r.completeness).toEqual({ status: 'complete', contentRevalidated: true });
    expect(r.eligibility).toEqual({ status: 'planning-eligible', reasons: [] });
    expect(r.findings.map((f) => f.rule)).toEqual(['NAME-VARIANTS']);
  });

  it('selo com formato, versão, algoritmo, derivação, canonicalização, cobertura e procedência', async () => {
    const doc = await sealed();
    expect(doc.integrity).toEqual({
      format: 'air-organizer/tree-inventory-seal',
      version: 1,
      algorithm: 'HMAC-SHA256',
      keyDerivation: 'HKDF-SHA256',
      canonicalization: 'canonical-json-v1',
      coverage: 'document-except-integrity',
      keyId: AUTH.keyId,
      sealedAt: FINISHED,
      mac: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});

describe('adulteração coerente é recusada (R3)', () => {
  // Cada adulteração mantém o inventário ESTRUTURALMENTE válido: só o selo a detecta.
  const renameEverywhere = (d: Doc) => {
    const x = clone(d);
    x.folders[0]!.items = x.folders[0]!.items.map((i) => (i.name === 'Gama' ? { ...i, name: 'Delta' } : i));
    x.folders = x.folders.map((f) => (f.name === 'Gama' ? { ...f, name: 'Delta', path: f.path?.replace('Gama', 'Delta') } : f));
    return x;
  };
  it.each<[string, (d: Doc) => Doc]>([
    ['nome (na linha do pai e na pasta)', renameEverywhere],
    ['caminho (prefixo reescrito em toda a árvore)', (d) => ({ ...d, folders: d.folders.map((f) => ({ ...f, path: f.path?.replace(/^\/[^/]+/, '/Outro Caminho') })) })],
    ['referência (pageUrl e contagem de páginas lidas)', (d) => ({ ...d, folders: d.folders.map((f, i) => (i === 1 ? { ...f, pageUrl: 'https://air.sigiloso.test/air/my-air/OUTRA', counts: { ...f.counts, pagesRead: 2 } } : f)) })],
    ['totais', (d) => ({ ...d, totals: { ...d.totals, items: d.totals.items + 5 } })],
    ['data de término (inventário vencido "rejuvenescido", selo junto)', (d) => ({ ...d, finishedAt: '2026-11-03T11:59:00.000Z', integrity: { ...d.integrity!, sealedAt: '2026-11-03T11:59:00.000Z' } })],
    ['ambiente (setor)', (d) => ({ ...d, environment: { ...d.environment, sector: { status: 'identified', value: 'Outro Setor', source: 'operator' } } })],
    ['identificador da execução', (d) => ({ ...d, runId: 'run-forjado' })],
    ['data do selo', (d) => ({ ...d, integrity: { ...d.integrity!, sealedAt: '2026-11-03T10:06:00.000Z' } })],
  ])('%s', async (_, tamper) => {
    const forged = tamper(await sealed());
    expect(validateInventory(forged)).toEqual([]); // estruturalmente coerente
    const r = analyze(forged);
    expect(r.integrity).toEqual({ status: 'invalid', reason: 'mac-mismatch' });
    expect(r.eligibility).toEqual({ status: 'rejected', reasons: [`integridade: ${INTEGRITY_MESSAGES['mac-mismatch']}`] });
    expect(r.findings).toEqual([]);
  });

  it('referência e contagens de pasta alteradas: recusado', async () => {
    const d = await sealed();
    const r1 = analyze({ ...d, folders: d.folders.map((f, i) => (i === 4 ? { ...f, ref: 'F99' } : f)) });
    const r2 = analyze({ ...d, folders: d.folders.map((f, i) => (i === 2 ? { ...f, counts: { ...f.counts, files: 1, items: 1 }, items: f.items.slice(0, 1) } : f)) });
    for (const r of [r1, r2]) {
      expect(r.integrity).toEqual({ status: 'invalid', reason: 'mac-mismatch' });
      expect(r.eligibility.status).toBe('rejected');
    }
  });

  it('eligibleForPlanning alterado: recusado (nos dois sentidos)', async () => {
    const eligible = await sealed();
    expect(analyze({ ...eligible, verification: { ...eligible.verification!, eligibleForPlanning: false } }).eligibility.status).toBe('rejected');
    const partial = await sealed(tree(), { limits: { ...WIDE, maxFolders: 2 } });
    const promoted = { ...partial, verification: { contentRevalidated: true, eligibleForPlanning: true } };
    expect(analyze(promoted).eligibility.status).toBe('rejected');
  });

  it('status e metadados de retomada alterados: recusado', async () => {
    const first = await scan(tree(), { behavior: { lose: ['c'] } });
    const fast = await sealed(tree(), { resume: { from: first.checkpoint, mode: 'fast' } });
    expect(analyze({ ...fast, resume: { ...fast.resume!, mode: 'verified' } }).eligibility.status).toBe('rejected');
    expect(analyze({ ...fast, resume: { ...fast.resume!, reusedFolders: 0 } }).eligibility.status).toBe('rejected');
    const partial = await sealed(tree(), { limits: { ...WIDE, maxFolders: 2 } });
    expect(analyze({ ...partial, status: 'failed' }).eligibility.status).toBe('rejected');
  });

  it('remover o selo nunca promove: fica sem selo, só exploratório', async () => {
    const { integrity: _removed, ...stripped } = await sealed();
    const r = analyze(stripped);
    expect(r.integrity).toEqual({ status: 'unsigned' });
    expect(r.eligibility).toEqual({ status: 'exploratory', reasons: ['integrity-unsigned'] });
  });

  it('C1: sem selo não é presumido legado; legado e selo removido têm a mesma classificação', async () => {
    expect(UNSIGNED_INVENTORY_MESSAGE).toBe('SEM SELO: inventário legado ou selo removido; conteúdo não autenticado.');
    const legacy = analyze(clone((await scan(tree())).plain));
    const { integrity: _removed, ...stripped } = await sealed();
    // Adulterado E sem selo: com selo seria recusado; sem ele, continua só exploratório.
    const forgedStripped = { ...stripped, environment: { ...stripped.environment, sector: { status: 'identified', value: 'Outro Setor', source: 'operator' } } };
    for (const r of [legacy, analyze(stripped), analyze(forgedStripped)]) {
      expect(r.integrity).toEqual({ status: 'unsigned' });
      expect(r.eligibility).toEqual({ status: 'exploratory', reasons: ['integrity-unsigned'] });
    }
    // Recente e completo não basta, com qualquer prazo.
    expect(analyzeStructure(stripped, { now: NOW, maxAgeDays: 365, authenticator: AUTH }).eligibility.status).toBe('exploratory');
  });
});

describe('código e chave', () => {
  it('código HMAC alterado ou malformado: recusado', async () => {
    const d = await sealed();
    const mac = d.integrity!.mac;
    const flipped = `${mac[0] === '0' ? '1' : '0'}${mac.slice(1)}`;
    expect(analyze({ ...d, integrity: { ...d.integrity!, mac: flipped } }).integrity).toEqual({ status: 'invalid', reason: 'mac-mismatch' });
    for (const bad of [mac.slice(2), mac.toUpperCase(), '', 42]) {
      expect(analyze({ ...d, integrity: { ...d.integrity!, mac: bad } }).integrity).toEqual({ status: 'invalid', reason: 'malformed-seal' });
    }
    expect(analyze({ ...d, integrity: 'qualquer' }).integrity).toEqual({ status: 'invalid', reason: 'malformed-seal' });
  });

  it('cabeçalho de outra versão, algoritmo ou com campo extra: recusado', async () => {
    const d = await sealed();
    for (const patch of [{ version: 2 }, { algorithm: 'SHA-256' }, { keyDerivation: 'none' }, { coverage: 'folders' }, { extra: 'x' }]) {
      expect(analyze({ ...d, integrity: { ...d.integrity!, ...patch } }).integrity).toEqual({ status: 'invalid', reason: 'unsupported-seal' });
    }
    expect(analyze({ ...d, integrity: { ...d.integrity!, sealedAt: '2026-11-03T10:00:00.000Z' } }).integrity).toEqual({ status: 'invalid', reason: 'inconsistent-seal' });
  });

  it('chave incorreta: recusado; trocar só o keyId também não passa', async () => {
    const d = await sealed();
    expect(analyze(d, { auth: OTHER }).integrity).toEqual({ status: 'invalid', reason: 'key-mismatch' });
    expect(analyze({ ...d, integrity: { ...d.integrity!, keyId: OTHER.keyId } }, { auth: OTHER }).integrity).toEqual({ status: 'invalid', reason: 'mac-mismatch' });
  });

  it('chave indisponível: não verificável, só exploratório', async () => {
    const r = analyze(await sealed(), { auth: null });
    expect(r.integrity).toEqual({ status: 'unverifiable', reason: 'key-unavailable' });
    expect(r.eligibility).toEqual({ status: 'exploratory', reasons: ['integrity-unverifiable'] });
  });

  it('separação de propósito: a subchave dos inventários não é a chave dos checkpoints', () => {
    const message = 'mensagem sintética';
    const withMaster = createHmac('sha256', MASTER).update(message, 'utf8').digest();
    expect(AUTH.mac(message).equals(withMaster)).toBe(false);
    expect(AUTH.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(inventoryAuthenticator(Buffer.from(MASTER)).keyId).toBe(AUTH.keyId); // determinística
    expect(OTHER.keyId).not.toBe(AUTH.keyId);
  });
});

describe('estados distintos de integridade, completude e elegibilidade', () => {
  it('legado (sem selo): exploratório mesmo com leitura completa e recente; achados continuam disponíveis', async () => {
    const r = analyze(clone((await scan(tree())).plain));
    expect(r.integrity).toEqual({ status: 'unsigned' });
    expect(r.completeness?.status).toBe('complete');
    expect(r.eligibility).toEqual({ status: 'exploratory', reasons: ['integrity-unsigned'] });
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it('parcial autenticado: íntegro, mas exploratório', async () => {
    const r = analyze(await sealed(tree(), { limits: { ...WIDE, maxFolders: 2 } }));
    expect(r.integrity.status).toBe('authenticated');
    expect(r.completeness?.status).toBe('partial');
    expect(r.eligibility).toEqual({ status: 'exploratory', reasons: ['status-partial', 'not-eligible-for-planning'] });
  });

  it('FAST autenticado: íntegro, mas exploratório', async () => {
    const first = await scan(tree(), { behavior: { lose: ['c'] } });
    const r = analyze(await sealed(tree(), { resume: { from: first.checkpoint, mode: 'fast' } }));
    expect(r.integrity.status).toBe('authenticated');
    expect(r.completeness).toEqual({ status: 'complete', contentRevalidated: false, resumeMode: 'fast' });
    expect(r.eligibility).toMatchObject({ status: 'exploratory', reasons: expect.arrayContaining(['fast-resume', 'reused-folders', 'not-eligible-for-planning']) });
  });

  it('autenticado, porém expirado: exploratório (integridade não é atualidade)', async () => {
    const r = analyze(await sealed(), { now: new Date('2026-11-20T00:00:00.000Z') });
    expect(r.integrity.status).toBe('authenticated');
    expect(r.eligibility).toEqual({ status: 'exploratory', reasons: ['stale'] });
  });
});

describe('canonicalização', () => {
  const reverseKeys = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;

  it('reordenar propriedades (em qualquer nível) e reformatar o JSON não invalida o selo', async () => {
    const d = await sealed();
    const reordered = JSON.parse(JSON.stringify(reverseKeys(d))) as Doc;
    expect(Object.keys(reordered)[0]).not.toBe(Object.keys(d)[0]);
    expect(analyze(reordered).integrity).toEqual({ status: 'authenticated' });
    expect(analyze(JSON.parse(JSON.stringify(d, null, 4))).integrity).toEqual({ status: 'authenticated' });
  });

  it('reordenar um array (pastas ou itens) muda o conteúdo: recusado', async () => {
    const d = await sealed();
    expect(analyze({ ...d, folders: [...d.folders].reverse() }).integrity).toEqual({ status: 'invalid', reason: 'mac-mismatch' });
  });

  it('o selo é calculado sobre o documento como gravado (campos undefined não contam)', async () => {
    const plain = (await scan(tree())).plain;
    const withUndefined = { ...plain, checkpointRunId: undefined };
    expect(verifyInventoryIntegrity(clone(sealInventory(withUndefined, AUTH, new Date(FINISHED))), AUTH)).toEqual({ status: 'authenticated' });
  });
});

describe('snapshot independente na selagem (C2)', () => {
  it('mudar o objeto original depois de selar não altera o inventário autenticado', async () => {
    const plain = (await scan(tree())).plain;
    const s = sealInventory(plain, AUTH, new Date(FINISHED));
    const before = JSON.stringify(s);
    expect(s.folders).not.toBe(plain.folders);
    expect(s.environment).not.toBe(plain.environment);
    plain.folders[0]!.name = 'MUTADO';
    plain.folders[1]!.items.push({ ...plain.folders[1]!.items[0]!, name: 'INJETADO' });
    plain.totals.items += 99;
    (plain.environment.sector as { value: string }).value = 'Outro Setor';
    expect(JSON.stringify(s)).toBe(before);
    expect(verifyInventoryIntegrity(s, AUTH)).toEqual({ status: 'authenticated' });
    expect(verifyInventoryIntegrity(clone(s), AUTH)).toEqual({ status: 'authenticated' });
  });

  it('o objeto selado é o próprio conteúdo autenticado, igual ao que é gravado', async () => {
    const plain = (await scan(tree())).plain;
    const s = sealInventory(plain, AUTH, new Date(FINISHED));
    expect(JSON.parse(JSON.stringify(s))).toEqual(s); // nada some nem muda ao serializar
    const { integrity: _i, ...body } = s;
    expect(body).toEqual(clone(plain));
  });

  it('exportação: mutação do TreeResult depois de exportar não afeta o arquivo autenticado', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-snapshot-'));
    try {
      const result = await scanTree(new SimNavigator(tree()), WIDE);
      const [, inv] = await exportTreeResult(result, { runId: 'run-s', startedAt: FINISHED, finishedAt: FINISHED, environment: ENV }, { detailed: true, authenticator: AUTH, now: new Date(FINISHED) }, dir);
      result.folders[0]!.name = 'MUTADO';
      const text = await readFile(inv!, 'utf-8');
      expect(text).not.toContain('MUTADO');
      expect(verifyInventoryIntegrity(JSON.parse(text), AUTH)).toEqual({ status: 'authenticated' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('chave local e exportação', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-integrity-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('verificação nunca cria a chave; o store cria e as duas concordam', async () => {
    const keyFile = path.join(dir, 'perfil', 'checkpoint.key');
    expect(await openVerifyingAuthenticator(keyFile, dir + '-repo')).toEqual({ unavailable: 'missing' });
    expect(existsSync(keyFile)).toBe(false);
    const store = await CheckpointStore.open({ dir: path.join(dir, 'perfil', 'checkpoints'), keyFile, retentionDays: 7, repositoryDir: dir + '-repo' });
    const verifying = await openVerifyingAuthenticator(keyFile, dir + '-repo');
    expect('authenticator' in verifying && verifying.authenticator.keyId).toBe(store.inventoryAuthenticator.keyId);
  });

  it('chave malformada, ilegível ou dentro do repositório: indisponível', async () => {
    const keyFile = path.join(dir, 'checkpoint.key');
    await writeFile(keyFile, 'nao-e-hex', 'utf-8');
    expect(await openVerifyingAuthenticator(keyFile, dir + '-repo')).toEqual({ unavailable: 'invalid' });
    await writeFile(keyFile, 'a'.repeat(64), 'utf-8');
    expect(await openVerifyingAuthenticator(keyFile, dir)).toEqual({ unavailable: 'invalid' }); // dentro do "repositório"
    await expect(CheckpointStore.open({ dir: path.join(dir + '-fora', 'c'), keyFile, retentionDays: 7, repositoryDir: dir })).rejects.toThrow(/repositório/);
    await mkdir(path.join(dir, 'pasta.key'));
    expect(await openVerifyingAuthenticator(path.join(dir, 'pasta.key'), dir + '-repo')).toEqual({ unavailable: 'unreadable' });
  });

  it('exportação com autenticador grava o selo; sem ele, sem selo; o diagnóstico sem nomes não muda', async () => {
    const out = path.join(dir, 'output');
    const meta = { runId: 'run-a', startedAt: FINISHED, finishedAt: FINISHED, environment: ENV };
    const result = await scanTree(new SimNavigator(tree()), WIDE);
    const [diag, inv] = await exportTreeResult(result, meta, { detailed: true, authenticator: AUTH, now: new Date(FINISHED) }, out);
    const r = analyzeStructure(await readInventory(inv!, out), { now: NOW, authenticator: AUTH });
    expect([r.integrity.status, r.eligibility.status]).toEqual(['authenticated', 'planning-eligible']);
    expect(JSON.parse(await readFile(diag!, 'utf-8'))).not.toHaveProperty('integrity');

    const [, unsigned] = await exportTreeResult(result, { ...meta, runId: 'run-b' }, { detailed: true }, out);
    expect(analyzeStructure(await readInventory(unsigned!, out), { now: NOW, authenticator: AUTH }).integrity).toEqual({ status: 'unsigned' });
  });
});

describe('privacidade', () => {
  it('relatório sem nomes e linhas de console não expõem nomes, chave, subchave nem código', async () => {
    const d = await sealed();
    const subkeyProbe = AUTH.mac('probe').toString('hex');
    const cases = [analyze(d), analyze({ ...d, runId: 'x' }), analyze(d, { auth: OTHER }), analyze(d, { auth: null })];
    const exposed = cases.map((r) => JSON.stringify(redactReport(r)) + r.eligibility.reasons.join(';') + r.findings.map(formatFinding).join('\n')).join('\n');
    for (const s of ['BELTRANA', 'Fulano', 'FULANO', '111.222', 'sigiloso', 'Sigiloso', MASTER.toString('hex'), subkeyProbe, d.integrity!.mac, AUTH.keyId, OTHER.keyId, '"name"', '"path"']) {
      expect(exposed).not.toContain(s);
    }
    for (const m of Object.values(INTEGRITY_MESSAGES)) expect(m).not.toMatch(/[0-9a-f]{16}/);
  });

  it('o inventário selado não contém a chave', async () => {
    const text = JSON.stringify(await sealed());
    expect(text).not.toContain(MASTER.toString('hex'));
    expect(text).not.toContain(AUTH.mac('probe').toString('hex'));
  });
});

describe('consistência da chave durante a execução (M1)', () => {
  let dir: string;
  let keyFile: string;
  const repositoryDir = () => dir + '-repo';
  const openStore = () => CheckpointStore.open({ dir: path.join(dir, 'checkpoints'), keyFile, retentionDays: 7, repositoryDir: repositoryDir(), now: () => NOW });
  const meta = (runId: string) => ({ runId, checkpointRunId: 'run-1', startedAt: FINISHED, finishedAt: FINISHED, environment: ENV });
  const verifyFromDisk = async (file: string) => {
    const key = await openVerifyingAuthenticator(keyFile, repositoryDir());
    return analyzeStructure(await readInventory(file, path.join(dir, 'output')), { now: NOW, ...('authenticator' in key ? { authenticator: key.authenticator } : {}) });
  };
  /** Mesma sequência das opções 6/7: checkpoint a cada passo e exportação selada pelo store. */
  async function runAndExport(store: CheckpointStore, runId: string) {
    const session = await store.create(store.scopeOf(ENV)!, 'run-1', WIDE);
    let result;
    try {
      result = await scanTree(new SimNavigator(tree()), WIDE, { checkpoint: { pseudonymize: store.pseudonymize, save: (s) => session.save(s) } });
    } finally {
      await session.release();
    }
    const [, inv] = await exportTreeResult(result, meta(runId), { detailed: true, authenticator: store.inventoryAuthenticator, now: new Date(FINISHED) }, path.join(dir, 'output'));
    return inv!;
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-m1-'));
    keyFile = path.join(dir, 'perfil', 'checkpoint.key');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('mesma chave em todo o ciclo: checkpoint, selo e verificação', async () => {
    const store = await openStore();
    const master = Buffer.from((await readFile(keyFile, 'utf-8')).trim(), 'hex');
    expect(store.inventoryAuthenticator.keyId).toBe(inventoryAuthenticator(master).keyId);
    const inv = await runAndExport(store, 'run-a');
    // Execução concluída: 'finished' só é atribuído DEPOIS de conferir o digest (mesma chave).
    expect((await store.list()).map((e) => e.rejection?.code)).toEqual(['finished']);
    expect((await verifyFromDisk(inv)).integrity).toEqual({ status: 'authenticated' });
  });

  it('chave removida do disco após a inicialização: exportação selada com a chave da execução, sem recriar', async () => {
    const store = await openStore();
    const original = await readFile(keyFile, 'utf-8');
    await unlink(keyFile);
    const inv = await runAndExport(store, 'run-b');
    expect(existsSync(keyFile)).toBe(false); // nenhuma recriação silenciosa
    expect(JSON.parse(await readFile(inv, 'utf-8')).integrity.keyId).toBe(store.inventoryAuthenticator.keyId);
    expect((await verifyFromDisk(inv)).integrity).toEqual({ status: 'unverifiable', reason: 'key-unavailable' });
    await writeFile(keyFile, original, 'utf-8'); // chave restaurada: o selo confere
    expect((await verifyFromDisk(inv)).integrity).toEqual({ status: 'authenticated' });
  });

  it('chave trocada no disco durante a execução: nada é relido; o selo continua da chave da execução', async () => {
    const store = await openStore();
    const keyId = store.inventoryAuthenticator.keyId;
    await writeFile(keyFile, 'b'.repeat(64), 'utf-8');
    const inv = await runAndExport(store, 'run-c');
    expect(store.inventoryAuthenticator.keyId).toBe(keyId);
    expect(await readFile(keyFile, 'utf-8')).toBe('b'.repeat(64)); // não sobrescrita
    // Verificados com a chave trocada: inventário e checkpoint recusados (falha fechada), nunca aceitos.
    expect((await verifyFromDisk(inv)).integrity).toEqual({ status: 'invalid', reason: 'key-mismatch' });
    expect((await (await openStore()).list()).map((e) => e.rejection?.code)).toEqual(['integrity']);
  });

  it('compatível com checkpoints existentes: reabrir o store mantém pseudônimos, checkpoints e keyId', async () => {
    const first = await openStore();
    await runAndExport(first, 'run-d');
    const reopened = await openStore();
    expect(reopened.pseudonymize('x')).toBe(first.pseudonymize('x'));
    expect(reopened.inventoryAuthenticator.keyId).toBe(first.inventoryAuthenticator.keyId);
    expect((await reopened.list()).map((e) => e.rejection?.code)).toEqual(['finished']); // digest confere
    // A chave dos checkpoints continua sendo a chave-mestra (pseudônimo = HMAC direto), e não a subchave.
    const master = Buffer.from((await readFile(keyFile, 'utf-8')).trim(), 'hex');
    expect(reopened.pseudonymize('x')).toBe(createHmac('sha256', master).update('x', 'utf8').digest('hex').slice(0, 32));
  });

  it('o store não expõe a chave-mestra nem a subchave', async () => {
    const store = await openStore();
    const master = (await readFile(keyFile, 'utf-8')).trim();
    const serialized = JSON.stringify(store) + JSON.stringify(store.inventoryAuthenticator) + Object.keys(store).join(',');
    expect(serialized).not.toContain(master);
    expect(Object.keys(store.inventoryAuthenticator).sort()).toEqual(['keyId', 'mac']);
  });
});
