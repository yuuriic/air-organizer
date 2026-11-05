import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppController, type AppEvent, type MovementPreviewView } from '../../src/app/controller.js';
import { planInventoryMovements } from '../../src/app/local-analysis.js';
import { parseDecisionRequest } from '../../src/app/movement-review.js';
import { InvalidInput } from '../../src/app/validation.js';
import { sealInventory } from '../../src/core/inventory-integrity.js';
import { DecisionRefused, approvalRefusal, createDecisionRecord, latestJustifications, parseDecisionDocument, proposalSignature, reconcileDecisions, sealDecisions, type DecisionRecord } from '../../src/core/movement-decisions.js';
import type { MovementPlan, MovementProposal } from '../../src/core/movement-planner.js';
import { scanTree } from '../../src/core/tree-scanner.js';
import { API_METHODS } from '../../src/desktop/ipc-contract.js';
import { treeInventoryDocument } from '../../src/storage/export.js';
import { decisionAuthenticator, inventoryAuthenticator } from '../../src/storage/integrity-key.js';
import type { AirEnvironment, TreeInventoryExport, TreeLimits } from '../../src/types/inventory.js';
import { SimNavigator, file, folder, type SimNode } from '../sim-navigator.js';

/** Só dados SINTÉTICOS (nomes fictícios, domínio .test, chave fixa de teste, diretórios temporários). */
const WIDE: TreeLimits = { maxDepth: 10, maxFolders: 200, maxItems: 10_000, maxPagesPerFolder: 50 };
const KEY = Buffer.alloc(32, 7);
const AUTH = inventoryAuthenticator(KEY);
const DECISION_AUTH = decisionAuthenticator(KEY);
const env = (at: string): AirEnvironment => ({
  instanceOrigin: { status: 'identified', value: 'https://air.sigiloso.test', source: 'url' },
  pageUrl: { status: 'identified', value: 'https://air.sigiloso.test/air/my-air/raiz', source: 'url' },
  client: { status: 'identified', value: 'Cliente Sigiloso', source: 'operator' },
  sector: { status: 'identified', value: 'Setor Sigiloso', source: 'operator' },
  currentFolder: { status: 'identified', value: 'Raiz', source: 'page-heading' },
  breadcrumb: { status: 'not-identified', reason: 'x' },
  observedAt: at,
});

async function inventory(root: SimNode): Promise<TreeInventoryExport> {
  const result = await scanTree(new SimNavigator(root), WIDE, {});
  const at = new Date(Date.now() - 60_000);
  const plain = JSON.parse(JSON.stringify(treeInventoryDocument(result, { runId: 'run-sintetico', startedAt: new Date(at.getTime() - 60_000).toISOString(), finishedAt: at.toISOString(), environment: env(at.toISOString()) }))) as TreeInventoryExport;
  return JSON.parse(JSON.stringify(sealInventory(plain, AUTH, at))) as TreeInventoryExport;
}

/** Consolidação: `ata` e `lista` da origem vão para a `2025` do destino, que pode já ter itens em conflito. */
const consolidation = (conflicting: SimNode[] = [], extra: SimNode[] = []) =>
  folder('raiz', 'Raiz', [folder('o', 'Origem Sigilosa', [folder('o1', '2025', [file('a', 'ata-sigilosa.pdf'), file('b', 'lista-sigilosa.pdf')])]), folder('d', 'Destino Sigiloso', [folder('d1', '2025', conflicting)]), ...extra]);
const CONFLICT = () => [file('e', 'ata-sigilosa.pdf')];
const FULL_CONFLICT = () => [file('e', 'ata-sigilosa.pdf'), file('f', 'LISTA-sigilosa.pdf')];

const refOf = (d: TreeInventoryExport, p: string) => d.folders.find((f) => f.path === p)!.ref;
const SENSITIVE = ['Sigilos', 'sigilos', 'Raiz', 'Origem', 'Destino', 'ata-', 'lista-', '.pdf', 'run-sintetico', 'air.', '"path"', '"name"', 'observationKey', 'pageUrl'];
const expectNoNames = (value: unknown) => {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  for (const term of SENSITIVE) expect(json).not.toContain(term);
};

const moveFiles = (view: MovementPreviewView) => view.proposals.filter((p) => p.kind === 'move-file');
const readyFile = (view: MovementPreviewView) => moveFiles(view).find((p) => p.state === 'ready-for-review')!;
const blockedFile = (view: MovementPreviewView) => moveFiles(view).find((p) => p.state === 'blocked')!;

let base = '';
let output = '';
let controller: AppController;
let events: AppEvent[] = [];
const decisionsDir = () => path.join(base, 'air-organizer', 'decisions');
const newController = (confirmDecisionHistoryReset?: () => boolean) => new AppController({ launch: () => Promise.reject(new Error('sem Chrome neste teste')), settingsFile: path.join(base, 'settings.json'), emit: (e) => events.push(e), env: { LOCALAPPDATA: base }, outputDir: output, ...(confirmDecisionHistoryReset ? { confirmDecisionHistoryReset } : {}) });

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-decisions-'));
  output = path.join(base, 'output');
  events = [];
  await mkdir(path.join(base, 'air-organizer'), { recursive: true });
  await writeFile(path.join(base, 'air-organizer', 'checkpoint.key'), KEY.toString('hex'));
  controller = newController();
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function save(doc: unknown, run = 'run-a'): Promise<string> {
  const dir = path.join(output, 'instancia', 'setor', run);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, 'tree-inventory.json');
  await writeFile(target, JSON.stringify(doc));
  return target;
}

/** Inventário aberto e seleção da consolidação, como a janela faria. */
async function open(conflicting: SimNode[] = [], c: AppController = controller) {
  const d = await inventory(consolidation(conflicting));
  const inventoryFile = await save(d);
  const inventoryId = (await c.listInventories())[0]!.id;
  await c.inspectInventory(inventoryId);
  const selection = { inventoryId, source: refOf(d, '/Raiz/Origem Sigilosa/2025'), destination: refOf(d, '/Raiz/Destino Sigiloso'), mode: 'folder' as const };
  return { d, inventoryFile, inventoryId, selection, view: await c.previewProposals(selection) };
}

const decisionFiles = async () => readdir(decisionsDir()).catch(() => [] as string[]);
const onlyDecisionFile = async () => {
  const [name, ...rest] = await decisionFiles();
  expect(rest).toEqual([]);
  return path.join(decisionsDir(), name!);
};
const planOf = async (inventoryFile: string, selection: { source: string; destination: string }, d: TreeInventoryExport): Promise<MovementPlan> => {
  const from = d.folders.find((f) => f.ref === selection.source)!;
  const to = d.folders.find((f) => f.ref === selection.destination)!;
  const { plan } = await planInventoryMovements(inventoryFile, { selections: [{ kind: 'folder', source: { path: from.path!, ref: from.ref }, destination: { path: to.path!, ref: to.ref } }] }, { keyFile: path.join(base, 'air-organizer', 'checkpoint.key'), maxAgeDays: 30, outputDir: output });
  return plan;
};

describe('aprovação e rejeição', () => {
  it('aprova proposta apta: registra localmente e só muda o estado da revisão', async () => {
    const { selection, view } = await open();
    const target = readyFile(view);
    expect(target.decision).toMatchObject({ status: 'pending', approvable: true, history: 0, authorizesExecution: false });
    expect(view.decisions).toMatchObject({ approved: 0, rejected: 0, pending: 3, notApprovable: 0, file: 'absent' });

    const after = await controller.decideProposal({ selection, proposalId: target.id, decision: 'approved' });
    const decided = after.proposals.find((p) => p.id === target.id)!;
    expect(decided.decision).toMatchObject({ status: 'approved', history: 1, hasJustification: false, authorizesExecution: false });
    expect(decided.decision.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(after.decisions).toMatchObject({ approved: 1, rejected: 0, pending: 2, notApprovable: 0, file: 'valid' });
    // O motor não muda por causa da decisão.
    expect(decided).toMatchObject({ state: 'ready-for-review', executable: false, authorizesChanges: false, review: 'pending' });
    expect(after).toMatchObject({ executable: false, authorizesChanges: false, summary: view.summary, safeOrder: view.safeOrder });
  });

  it('rejeita com justificativa, e a última decisão prevalece sem apagar o histórico', async () => {
    const { selection, view } = await open();
    const target = readyFile(view);
    await controller.decideProposal({ selection, proposalId: target.id, decision: 'approved' });
    const after = await controller.decideProposal({ selection, proposalId: target.id, decision: 'rejected', justification: '  fora do lote\r\nsintético  ' });
    expect(after.proposals.find((p) => p.id === target.id)!.decision).toMatchObject({ status: 'rejected', history: 2, hasJustification: true });
    expect(after.decisions).toMatchObject({ approved: 0, rejected: 1, pending: 2 });
    const saved = JSON.parse(await readFile(await onlyDecisionFile(), 'utf-8'));
    expect(saved.decisions.map((r: DecisionRecord) => r.decision)).toEqual(['approved', 'rejected']);
    expect(saved.decisions[1].justification).toBe('fora do lote\nsintético');
  });

  it('agrupamento apto pode ser aprovado, sem aprovar as operações dele', async () => {
    const { selection, view } = await open();
    const group = view.proposals.find((p) => p.kind === 'consolidate-folder')!;
    expect(group.group).toMatchObject({ status: 'all-ready', authorizesOperations: false });
    const after = await controller.decideProposal({ selection, proposalId: group.id, decision: 'approved' });
    expect(after.proposals.find((p) => p.id === group.id)!.decision.status).toBe('approved');
    expect(moveFiles(after).map((p) => p.decision.status)).toEqual(['pending', 'pending']);
    expect(after.proposals.find((p) => p.id === group.id)!.group!.authorizesOperations).toBe(false);
  });
});

describe('o que não pode ser aprovado', () => {
  it('proposta bloqueada: aprovação recusada e nada gravado; rejeição é permitida', async () => {
    const { selection, view } = await open(CONFLICT());
    const blocked = blockedFile(view);
    expect(blocked.decision).toMatchObject({ status: 'pending', approvable: false, approvalRefusal: expect.stringContaining('bloqueada') });
    await expect(controller.decideProposal({ selection, proposalId: blocked.id, decision: 'approved' })).rejects.toMatchObject({ code: 'decision-refused' });
    expect(await decisionFiles()).toEqual([]);
    const after = await controller.decideProposal({ selection, proposalId: blocked.id, decision: 'rejected' });
    expect(after.proposals.find((p) => p.id === blocked.id)!).toMatchObject({ state: 'blocked', decision: { status: 'rejected', approvable: false } });
  });

  it('consolidação parcialmente bloqueada: não é aprovada inteira; só a operação apta individualmente', async () => {
    const { selection, view } = await open(CONFLICT());
    const group = view.proposals.find((p) => p.kind === 'consolidate-folder')!;
    expect(group).toMatchObject({ state: 'ready-for-review', group: { status: 'partially-blocked', authorizesOperations: false }, decision: { approvable: false } });
    expect(view.decisions).toMatchObject({ pending: 1, notApprovable: 2 });
    await expect(controller.decideProposal({ selection, proposalId: group.id, decision: 'approved' })).rejects.toMatchObject({ code: 'decision-refused' });
    await expect(controller.decideProposal({ selection, proposalId: blockedFile(view).id, decision: 'approved' })).rejects.toMatchObject({ code: 'decision-refused' });
    expect(await decisionFiles()).toEqual([]);

    const after = await controller.decideProposal({ selection, proposalId: readyFile(view).id, decision: 'approved' });
    expect(after.proposals.find((p) => p.id === group.id)!.decision.status).toBe('pending');
    expect(blockedFile(after).decision.status).toBe('pending');
    expect(readyFile(after).decision.status).toBe('approved');
    expect(after.decisions).toMatchObject({ approved: 1, pending: 0, notApprovable: 2 });
  });

  it('consolidação totalmente bloqueada: nada pode ser aprovado', async () => {
    const { selection, view } = await open(FULL_CONFLICT());
    expect(view.decisions).toMatchObject({ approved: 0, pending: 0, notApprovable: view.proposals.length });
    for (const p of view.proposals) await expect(controller.decideProposal({ selection, proposalId: p.id, decision: 'approved' })).rejects.toMatchObject({ code: 'decision-refused' });
    expect(await decisionFiles()).toEqual([]);
  });

  it('a regra está no núcleo: nenhum chamador cria aprovação de proposta não apta', async () => {
    const { d, inventoryFile, selection } = await open(CONFLICT());
    const plan = await planOf(inventoryFile, selection, d);
    const blocked = plan.proposals.find((p) => p.state === 'blocked')!;
    expect(approvalRefusal(blocked)).toBeDefined();
    expect(() => createDecisionRecord(plan, blocked, 'approved', undefined, new Date(), DECISION_AUTH)).toThrow(DecisionRefused);
    expect(createDecisionRecord(plan, blocked, 'rejected', undefined, new Date(), DECISION_AUTH)).toMatchObject({ decision: 'rejected', executable: false, authorizesChanges: false });
  });

  it('contrato: plano ou proposta apresentados como executáveis são recusados', async () => {
    const { d, inventoryFile, selection } = await open();
    const plan = await planOf(inventoryFile, selection, d);
    const ready = plan.proposals.find((p) => p.kind === 'move-file')!;
    const forged = { ...ready, executable: true } as unknown as MovementProposal;
    expect(() => createDecisionRecord(plan, forged, 'approved', undefined, new Date(), DECISION_AUTH)).toThrow(/executável/);
    expect(() => reconcileDecisions({ ...plan, proposals: [forged] }, [], DECISION_AUTH)).toThrow(/executável/);
    const group = plan.proposals.find((p) => p.kind === 'consolidate-folder')!;
    const authorizing = { ...group, group: { ...group.group!, authorizesOperations: true } } as unknown as MovementProposal;
    expect(() => createDecisionRecord(plan, authorizing, 'approved', undefined, new Date(), DECISION_AUTH)).toThrow(/executável/);
  });
});

describe('persistência e recuperação', () => {
  it('recupera as decisões ao reabrir o aplicativo', async () => {
    const { selection, view, inventoryId } = await open();
    await controller.decideProposal({ selection, proposalId: readyFile(view).id, decision: 'approved', justification: 'lote sintético' });

    const reopened = newController();
    await reopened.listInventories();
    await reopened.inspectInventory(inventoryId);
    const recovered = await reopened.previewProposals(selection);
    expect(readyFile(recovered).decision).toMatchObject({ status: 'approved', hasJustification: true, history: 1 });
    expect(recovered.decisions).toMatchObject({ approved: 1, pending: 2, file: 'valid' });
  });

  it('arquivo fora do repositório e de output/, com os campos exigidos e sem credenciais', async () => {
    const { selection, view, d, inventoryFile } = await open();
    await controller.decideProposal({ selection, proposalId: readyFile(view).id, decision: 'approved', justification: 'lote sintético' });
    const target = await onlyDecisionFile();
    expect(path.relative(output, target)).toMatch(/^\.\./);
    expect(path.relative(process.cwd(), target)).toMatch(/^\.\./);
    const doc = JSON.parse(await readFile(target, 'utf-8'));
    expect(Object.keys(doc).sort()).toEqual(['authorizesChanges', 'decisions', 'executable', 'inventoryId', 'keyId', 'kind', 'schemaVersion', 'seal']);
    const plan = await planOf(inventoryFile, selection, d);
    expect(doc.decisions[0]).toEqual({
      inventoryId: plan.source.inventoryId,
      proposalId: readyFile(view).id,
      signature: expect.stringMatching(/^[0-9a-f]{64}$/),
      decision: 'approved',
      decidedAt: expect.any(String),
      justification: 'lote sintético',
      planning: { format: plan.kind, schemaVersion: plan.schemaVersion, plannerVersion: plan.plannerVersion, engineVersion: plan.engineVersion },
      executable: false,
      authorizesChanges: false,
    });
    expect(await readFile(target, 'utf-8')).not.toMatch(/password|senha|token|cookie|credential/i);
    expect(await readFile(target, 'utf-8')).not.toContain(KEY.toString('hex'));
  });

  it('decidir não altera o inventário nem grava nada em output/', async () => {
    const { selection, view, inventoryFile } = await open();
    const content = await readFile(inventoryFile, 'utf-8');
    const before = await readdir(path.dirname(inventoryFile));
    await controller.decideProposal({ selection, proposalId: readyFile(view).id, decision: 'rejected' });
    expect(await readFile(inventoryFile, 'utf-8')).toBe(content);
    expect(await readdir(path.dirname(inventoryFile))).toEqual(before);
  });
});

describe('JSON local inválido', () => {
  /** Aprova, adultera o arquivo e reabre. */
  async function tampered(edit: (text: string) => string) {
    const { selection, view, inventoryId } = await open();
    await controller.decideProposal({ selection, proposalId: readyFile(view).id, decision: 'approved' });
    const target = await onlyDecisionFile();
    await writeFile(target, edit(await readFile(target, 'utf-8')));
    await controller.inspectInventory(inventoryId);
    return { selection, target, proposalId: readyFile(view).id, after: await controller.previewProposals(selection) };
  }

  it.each<[string, (text: string) => string]>([
    ['JSON corrompido', (t) => t.slice(0, 40)],
    ['decisão trocada à mão', (t) => t.replace('"approved"', '"rejected"')],
    ['justificativa inserida à mão', (t) => t.replace('"decision": "approved"', '"justification": "x", "decision": "approved"')],
    ['campo desconhecido', (t) => t.replace('"seal"', '"extra": 1, "seal"')],
    ['aparência de autorização', (t) => t.replace(/"executable": false/g, '"executable": true')],
    ['raiz que não é objeto', () => '[]'],
    ['selo removido', (t) => t.replace(/"seal": "[0-9a-f]+"/, '"seal": ""')],
  ])('%s: arquivo ignorado inteiro, tudo pendente, com aviso', async (_label, edit) => {
    const { after } = await tampered(edit);
    expect(after.decisions).toMatchObject({ approved: 0, rejected: 0, file: 'invalid' });
    for (const p of after.proposals) expect(p.decision).toMatchObject({ status: 'pending', history: 0 });
  });

  it('registro fora do formato é recusado mesmo com selo válido', async () => {
    const { d, inventoryFile, selection } = await open();
    const plan = await planOf(inventoryFile, selection, d);
    const id = plan.source.inventoryId!;
    const record = createDecisionRecord(plan, plan.proposals[0]!, 'approved', undefined, new Date(), DECISION_AUTH);
    const bad: Array<[string, unknown]> = [
      ['campo extra', { ...record, authorizedBy: 'x' }],
      ['executável', { ...record, executable: true }],
      ['autoriza mudanças', { ...record, authorizesChanges: true }],
      ['outro inventário', { ...record, inventoryId: '0000000000000000' }],
      ['decisão desconhecida', { ...record, decision: 'executed' }],
      ['data inválida', { ...record, decidedAt: 'ontem' }],
      ['proposta com caminho', { ...record, proposalId: '../x' }],
      ['justificativa longa', { ...record, justification: 'x'.repeat(501) }],
      ['sem versão', { ...record, planning: undefined }],
    ];
    for (const [, candidate] of bad) expect(parseDecisionDocument(sealDecisions(id, [candidate as DecisionRecord], DECISION_AUTH), id, DECISION_AUTH)).toBeUndefined();
  });

  it('selo feito com a subchave do inventário não vale para decisões', async () => {
    const { d, inventoryFile, selection } = await open();
    const plan = await planOf(inventoryFile, selection, d);
    const record = createDecisionRecord(plan, plan.proposals[0]!, 'approved', undefined, new Date(), DECISION_AUTH);
    const id = plan.source.inventoryId!;
    expect(parseDecisionDocument(sealDecisions(id, [record], DECISION_AUTH), id, DECISION_AUTH)).toEqual([record]);
    expect(parseDecisionDocument(sealDecisions(id, [record], AUTH), id, DECISION_AUTH)).toBeUndefined();
  });
});

describe('histórico inválido', () => {
  const CORRUPT = (t: string) => t.slice(0, 40);
  const BAD_HMAC = (t: string) => t.replace(/"seal": "[0-9a-f]+"/, `"seal": "${'0'.repeat(64)}"`);
  const FORGED_DECISION = (t: string) => t.replace('"approved"', '"rejected"');

  /** Registra uma aprovação, adultera o arquivo e reabre o inventário com o controlador indicado. */
  async function broken(edit: (text: string) => string, confirm?: () => boolean) {
    const c = newController(confirm);
    const { selection, view, inventoryId } = await open([], c);
    const target = readyFile(view);
    await c.decideProposal({ selection, proposalId: target.id, decision: 'approved', justification: 'decisão antiga' });
    const file = await onlyDecisionFile();
    await writeFile(file, edit(await readFile(file, 'utf-8')));
    const content = await readFile(file, 'utf-8');
    return { c, selection, inventoryId, target, file, content, after: await c.previewProposals(selection) };
  }
  const backups = async () => (await decisionFiles()).filter((n) => n.includes('.invalido-'));

  it.each<[string, (t: string) => string]>([
    ['JSON corrompido', CORRUPT],
    ['HMAC inválido', BAD_HMAC],
    ['decisão editada à mão', FORGED_DECISION],
  ])('%s: avisa, ignora e bloqueia aprovar e rejeitar, sem tocar no arquivo', async (_label, edit) => {
    const { c, selection, target, file, content, after } = await broken(edit);
    expect(after.decisions).toMatchObject({ approved: 0, rejected: 0, file: 'invalid' });
    for (const p of after.proposals) expect(p.decision.status).toBe('pending');
    for (const decision of ['approved', 'rejected']) {
      await expect(c.decideProposal({ selection, proposalId: target.id, decision })).rejects.toMatchObject({ code: 'decision-history-invalid' });
    }
    expect(await readFile(file, 'utf-8')).toBe(content);
    expect(await backups()).toEqual([]);
  });

  it('confirmação explícita: guarda o original intacto, cria histórico válido e vazio, sem importar nada', async () => {
    let asked = 0;
    const { c, selection, inventoryId, target, file, content } = await broken(BAD_HMAC, () => {
      asked++;
      return true;
    });
    await expect(c.resetDecisionHistory(inventoryId)).resolves.toEqual({ outcome: 'reset' });
    expect(asked).toBe(1);

    const [copy, ...others] = await backups();
    expect(others).toEqual([]);
    expect(await readFile(path.join(decisionsDir(), copy!), 'utf-8')).toBe(content);
    const fresh = JSON.parse(await readFile(file, 'utf-8'));
    expect(fresh.decisions).toEqual([]);
    expect(fresh).toMatchObject({ executable: false, authorizesChanges: false });

    const view = await c.previewProposals(selection);
    expect(view.decisions).toMatchObject({ approved: 0, rejected: 0, pending: 3, invalidated: 0, file: 'valid' });
    expect(readyFile(view).decision).toMatchObject({ status: 'pending', history: 0 });
    expect(await c.revealDecisionNotes(inventoryId)).toEqual({});

    const next = await c.decideProposal({ selection, proposalId: target.id, decision: 'approved' });
    expect(next.decisions).toMatchObject({ approved: 1, file: 'valid' });
    expect(await backups()).toEqual([copy]);
  });

  it('cada reinício guarda a própria cópia, sem substituir as anteriores', async () => {
    const { c, inventoryId, file } = await broken(CORRUPT, () => true);
    await c.resetDecisionHistory(inventoryId);
    await writeFile(file, 'outro conteúdo inválido');
    await c.resetDecisionHistory(inventoryId);
    const kept = await Promise.all((await backups()).map((n) => readFile(path.join(decisionsDir(), n), 'utf-8')));
    expect(kept).toHaveLength(2);
    expect(kept).toContain('outro conteúdo inválido');
  });

  it('operador cancela: nada muda e as decisões seguem bloqueadas', async () => {
    const { c, selection, inventoryId, target, file, content } = await broken(CORRUPT, () => false);
    await expect(c.resetDecisionHistory(inventoryId)).resolves.toEqual({ outcome: 'cancelled' });
    expect(await readFile(file, 'utf-8')).toBe(content);
    expect(await backups()).toEqual([]);
    await expect(c.decideProposal({ selection, proposalId: target.id, decision: 'approved' })).rejects.toMatchObject({ code: 'decision-history-invalid' });
  });

  it('sem confirmação no processo principal, o pedido nunca reinicia', async () => {
    const { c, inventoryId, file, content } = await broken(CORRUPT);
    await expect(c.resetDecisionHistory(inventoryId)).resolves.toEqual({ outcome: 'cancelled' });
    expect(await readFile(file, 'utf-8')).toBe(content);
    expect(await backups()).toEqual([]);
  });

  it('chamada direta ao IPC não contorna a confirmação', async () => {
    let asked = 0;
    const { c, selection, inventoryId, target, file, content } = await broken(CORRUPT, () => {
      asked++;
      return false;
    });
    // Campos que tentam afirmar a confirmação são recusados na validação, sem mudar nada.
    for (const extra of [{ confirmed: true }, { resetHistory: true }, { force: true }]) {
      await expect(c.decideProposal({ selection, proposalId: target.id, decision: 'approved', ...extra })).rejects.toThrow(InvalidInput);
    }
    for (const payload of [{ inventoryId, confirmed: true }, { inventoryId }, [inventoryId], true, undefined]) {
      await expect(c.resetDecisionHistory(payload)).rejects.toThrow(InvalidInput);
    }
    expect(asked).toBe(0);
    // O identificador válido, sozinho, só leva à pergunta: quem responde é o processo principal.
    await expect(c.resetDecisionHistory(inventoryId)).resolves.toEqual({ outcome: 'cancelled' });
    expect(asked).toBe(1);
    await expect(c.decideProposal({ selection, proposalId: target.id, decision: 'rejected' })).rejects.toMatchObject({ code: 'decision-history-invalid' });
    expect(await readFile(file, 'utf-8')).toBe(content);
    expect(await backups()).toEqual([]);
  });

  it('inventário sem histórico: decide sem nenhuma confirmação, e não há o que reiniciar', async () => {
    let asked = 0;
    const c = newController(() => {
      asked++;
      return true;
    });
    const { selection, view, inventoryId } = await open([], c);
    expect(view.decisions.file).toBe('absent');
    await expect(c.resetDecisionHistory(inventoryId)).rejects.toMatchObject({ code: 'decision-history-not-invalid' });
    expect(await decisionFiles()).toEqual([]);
    const after = await c.decideProposal({ selection, proposalId: readyFile(view).id, decision: 'approved' });
    expect(after.decisions).toMatchObject({ approved: 1, file: 'valid' });
    expect(asked).toBe(0);
    expect(await backups()).toEqual([]);
  });

  it('histórico válido não pode ser reiniciado, nem com confirmação', async () => {
    let asked = 0;
    const c = newController(() => {
      asked++;
      return true;
    });
    const { selection, view, inventoryId } = await open([], c);
    await c.decideProposal({ selection, proposalId: readyFile(view).id, decision: 'approved' });
    const file = await onlyDecisionFile();
    const content = await readFile(file, 'utf-8');
    await expect(c.resetDecisionHistory(inventoryId)).rejects.toMatchObject({ code: 'decision-history-not-invalid' });
    expect(asked).toBe(0);
    expect(await readFile(file, 'utf-8')).toBe(content);
    expect(await backups()).toEqual([]);
  });

  it('o bloqueio vale só para o inventário afetado', async () => {
    const first = await inventory(consolidation());
    const second = await inventory(consolidation([], [folder('x', 'Extra Sigilosa')]));
    await save(first, 'run-a');
    await save(second, 'run-b');
    const c = newController();
    const byFolders = new Map<number, string>();
    for (const { id } of await c.listInventories()) byFolders.set((await c.inspectInventory(id)).counts!.folders, id);
    const pick = (d: TreeInventoryExport) => ({ inventoryId: byFolders.get(d.folders.length)!, source: refOf(d, '/Raiz/Origem Sigilosa/2025'), destination: refOf(d, '/Raiz/Destino Sigiloso'), mode: 'folder' as const });
    await c.inspectInventory(pick(first).inventoryId);
    const a = await c.previewProposals(pick(first));
    await c.decideProposal({ selection: pick(first), proposalId: readyFile(a).id, decision: 'approved' });
    await writeFile(await onlyDecisionFile(), 'inválido');

    await c.inspectInventory(pick(second).inventoryId);
    const b = await c.previewProposals(pick(second));
    expect(b.decisions.file).toBe('absent');
    await expect(c.decideProposal({ selection: pick(second), proposalId: readyFile(b).id, decision: 'approved' })).resolves.toMatchObject({ decisions: { approved: 1, file: 'valid' } });
  });
});

describe('independência entre consolidação e operações', () => {
  const groupOf = (view: MovementPreviewView) => view.proposals.find((p) => p.kind === 'consolidate-folder')!;

  it('aprovar a consolidação não aprova as operações', async () => {
    const { selection, view } = await open();
    const after = await controller.decideProposal({ selection, proposalId: groupOf(view).id, decision: 'approved' });
    expect(groupOf(after).decision.status).toBe('approved');
    expect(moveFiles(after).map((p) => p.decision.status)).toEqual(['pending', 'pending']);
    expect(after.decisions).toMatchObject({ approved: 1, pending: 2 });
  });

  it('aprovar a operação não aprova a consolidação', async () => {
    const { selection, view } = await open();
    const after = await controller.decideProposal({ selection, proposalId: readyFile(view).id, decision: 'approved' });
    expect(readyFile(after).decision.status).toBe('approved');
    expect(groupOf(after).decision.status).toBe('pending');
  });

  it('rejeitar a consolidação não muda operações aprovadas, e nada disso autoriza execução', async () => {
    const { selection, view } = await open();
    const child = readyFile(view);
    await controller.decideProposal({ selection, proposalId: child.id, decision: 'approved' });
    const after = await controller.decideProposal({ selection, proposalId: groupOf(view).id, decision: 'rejected' });
    expect(groupOf(after).decision.status).toBe('rejected');
    expect(after.proposals.find((p) => p.id === child.id)!.decision.status).toBe('approved');
    expect(after).toMatchObject({ executable: false, authorizesChanges: false });
    for (const p of after.proposals) expect(p).toMatchObject({ executable: false, authorizesChanges: false, decision: { authorizesExecution: false } });
    expect(groupOf(after).group!.authorizesOperations).toBe(false);
  });

  it('a ordem das decisões não muda o resultado', async () => {
    const { selection, view } = await open();
    const child = readyFile(view);
    await controller.decideProposal({ selection, proposalId: groupOf(view).id, decision: 'rejected' });
    const after = await controller.decideProposal({ selection, proposalId: child.id, decision: 'approved' });
    expect(groupOf(after).decision.status).toBe('rejected');
    expect(after.proposals.find((p) => p.id === child.id)!.decision.status).toBe('approved');
  });

  it('em consolidação parcial, a rejeição dela convive com a operação apta aprovada', async () => {
    const { selection, view } = await open(CONFLICT());
    await controller.decideProposal({ selection, proposalId: readyFile(view).id, decision: 'approved' });
    const after = await controller.decideProposal({ selection, proposalId: groupOf(view).id, decision: 'rejected' });
    expect(groupOf(after)).toMatchObject({ group: { status: 'partially-blocked', authorizesOperations: false }, decision: { status: 'rejected', approvable: false } });
    expect(readyFile(after).decision.status).toBe('approved');
    expect(blockedFile(after).decision.status).toBe('pending');
  });
});

describe('invalidação quando a proposta muda', () => {
  it('mesma operação com outro conteúdo: a decisão deixa de valer e volta a valer só para o conteúdo decidido', async () => {
    const { d, selection, view, inventoryId } = await open();
    const child = readyFile(view);
    const approved = await controller.decideProposal({ selection, proposalId: child.id, decision: 'approved' });
    expect(readyFile(approved).decision.status).toBe('approved');

    // A mesma operação, pedida isoladamente: mesmo identificador, sem o vínculo com a consolidação.
    const alone = { inventoryId, source: child.source!, destination: refOf(d, '/Raiz/Destino Sigiloso/2025') };
    const changed = await controller.previewProposals(alone);
    expect(changed.proposals.map((p) => p.id)).toEqual([child.id]);
    expect(changed.proposals[0]!.decision).toMatchObject({ status: 'pending', approvable: true, invalidated: 'content-changed', history: 1, hasJustification: false });
    expect(changed.decisions).toMatchObject({ approved: 0, pending: 1, invalidated: 1 });
    expect(changed.proposals[0]!.decision.decidedAt).toBeUndefined();

    const back = await controller.previewProposals(selection);
    expect(readyFile(back).decision.status).toBe('approved');
  });

  it('rejeição também não vale para conteúdo diferente', async () => {
    const { d, selection, view, inventoryId } = await open();
    const child = readyFile(view);
    await controller.decideProposal({ selection, proposalId: child.id, decision: 'rejected' });
    const changed = await controller.previewProposals({ inventoryId, source: child.source!, destination: refOf(d, '/Raiz/Destino Sigiloso/2025') });
    expect(changed.proposals[0]!.decision).toMatchObject({ status: 'pending', invalidated: 'content-changed' });
  });

  it.each<[string, (plan: MovementPlan) => MovementPlan]>([
    ['versão do planejador', (plan) => ({ ...plan, plannerVersion: '999' })],
    ['versão do motor', (plan) => ({ ...plan, engineVersion: '999' })],
    ['justificativa do motor', (plan) => ({ ...plan, proposals: plan.proposals.map((p) => ({ ...p, justification: `${p.justification} ` })) })],
    ['dependências', (plan) => ({ ...plan, proposals: plan.proposals.map((p) => ({ ...p, dependsOn: [...p.dependsOn, 'M-0000000000000000'] })) })],
  ])('mudança de %s invalida a decisão', async (_label, change) => {
    const { d, inventoryFile, selection } = await open();
    const plan = await planOf(inventoryFile, selection, d);
    const target = plan.proposals.find((p) => p.kind === 'move-file')!;
    const record = createDecisionRecord(plan, target, 'approved', undefined, new Date(), DECISION_AUTH);
    expect(reconcileDecisions(plan, [record], DECISION_AUTH).states.get(target.id)).toMatchObject({ status: 'approved' });
    const { states, summary } = reconcileDecisions(change(plan), [record], DECISION_AUTH);
    expect(states.get(target.id)).toMatchObject({ status: 'pending', invalidated: 'content-changed' });
    expect(summary.approved).toBe(0);
  });

  it('assinatura determinística: o mesmo plano assina igual', async () => {
    const { d, inventoryFile, selection } = await open();
    const a = await planOf(inventoryFile, selection, d);
    const b = await planOf(inventoryFile, selection, d);
    expect(a.proposals.map((p) => proposalSignature(a, p, DECISION_AUTH))).toEqual(b.proposals.map((p) => proposalSignature(b, p, DECISION_AUTH)));
  });

  it('aprovação forjada com a chave para proposta bloqueada não vale, nem com assinatura correta', async () => {
    const { d, inventoryFile, selection, view, inventoryId } = await open(CONFLICT());
    const plan = await planOf(inventoryFile, selection, d);
    const blocked = plan.proposals.find((p) => p.state === 'blocked')!;
    const forged: DecisionRecord = { ...createDecisionRecord(plan, blocked, 'rejected', undefined, new Date(), DECISION_AUTH), decision: 'approved' };
    expect(forged.signature).toBe(proposalSignature(plan, blocked, DECISION_AUTH));
    await mkdir(decisionsDir(), { recursive: true });
    await writeFile(path.join(decisionsDir(), `${plan.source.inventoryId}.json`), JSON.stringify(sealDecisions(plan.source.inventoryId!, [forged], DECISION_AUTH)));

    await controller.inspectInventory(inventoryId);
    const after = await controller.previewProposals(selection);
    expect(after.decisions).toMatchObject({ approved: 0, invalidated: 1, file: 'valid' });
    expect(blockedFile(after).id).toBe(blocked.id);
    expect(blockedFile(after).decision).toMatchObject({ status: 'pending', invalidated: 'not-approvable', approvable: false });
    expect(blockedFile(view).decision.invalidated).toBeUndefined();
  });
});

describe('troca de inventário', () => {
  async function twoInventories() {
    const first = await inventory(consolidation());
    const second = await inventory(consolidation([], [folder('x', 'Extra Sigilosa')]));
    await save(first, 'run-a');
    await save(second, 'run-b');
    const ids = (await controller.listInventories()).map((i) => i.id);
    const byFolders = new Map<number, string>();
    for (const id of ids) byFolders.set((await controller.inspectInventory(id)).counts!.folders, id);
    const pick = (d: TreeInventoryExport) => {
      const inventoryId = byFolders.get(d.folders.length)!;
      return { inventoryId, source: refOf(d, '/Raiz/Origem Sigilosa/2025'), destination: refOf(d, '/Raiz/Destino Sigiloso'), mode: 'folder' as const };
    };
    return { a: pick(first), b: pick(second) };
  }

  it('aprovação de um inventário não vale em outro, mesmo com a mesma estrutura de seleção', async () => {
    const { a, b } = await twoInventories();
    await controller.inspectInventory(a.inventoryId);
    const viewA = await controller.previewProposals(a);
    await controller.decideProposal({ selection: a, proposalId: readyFile(viewA).id, decision: 'approved' });

    await controller.inspectInventory(b.inventoryId);
    const viewB = await controller.previewProposals(b);
    expect(viewB.decisions).toMatchObject({ approved: 0, invalidated: 0, file: 'absent' });
    expect(viewB.proposals.map((p) => p.id)).not.toContain(readyFile(viewA).id);

    await controller.inspectInventory(a.inventoryId);
    expect((await controller.previewProposals(a)).decisions.approved).toBe(1);
  });

  it('identificador de proposta de outro inventário é recusado', async () => {
    const { a, b } = await twoInventories();
    await controller.inspectInventory(a.inventoryId);
    const viewA = await controller.previewProposals(a);
    await controller.inspectInventory(b.inventoryId);
    await expect(controller.decideProposal({ selection: b, proposalId: readyFile(viewA).id, decision: 'approved' })).rejects.toMatchObject({ code: 'proposal-not-found' });
    await expect(controller.decideProposal({ selection: a, proposalId: readyFile(viewA).id, decision: 'approved' })).rejects.toThrow(InvalidInput);
    expect(await decisionFiles()).toEqual([]);
  });

  it('arquivo de decisões copiado para outro inventário é inválido', async () => {
    const { a, b } = await twoInventories();
    await controller.inspectInventory(a.inventoryId);
    const viewA = await controller.previewProposals(a);
    await controller.decideProposal({ selection: a, proposalId: readyFile(viewA).id, decision: 'approved' });
    const source = await onlyDecisionFile();

    await controller.inspectInventory(b.inventoryId);
    await controller.previewProposals(b);
    const secondFile = path.join(output, 'instancia', 'setor', 'run-b', 'tree-inventory.json');
    const second = await planOf(secondFile, b, JSON.parse(await readFile(secondFile, 'utf-8')) as TreeInventoryExport);
    await writeFile(path.join(decisionsDir(), `${second.source.inventoryId}.json`), await readFile(source));
    const viewB = await controller.previewProposals(b);
    expect(viewB.decisions).toMatchObject({ approved: 0, file: 'invalid' });
  });

  it('inventário alterado depois da análise: decisão recusada até nova análise', async () => {
    const { selection, view, inventoryFile } = await open();
    await writeFile(inventoryFile, JSON.stringify(await inventory(consolidation([], [folder('x', 'Extra Sigilosa')]))));
    await expect(controller.decideProposal({ selection, proposalId: readyFile(view).id, decision: 'approved' })).rejects.toMatchObject({ code: 'inventory-changed' });
    expect(await decisionFiles()).toEqual([]);
  });
});

describe('tentativas pelo IPC', () => {
  const inventoryId = 'inv-1111111111111111';
  const selection = { inventoryId, source: 'F3', destination: 'F2', mode: 'folder' };
  const proposalId = 'M-0123456789abcdef';

  it('aceita só o formato esperado e normaliza a justificativa', () => {
    expect(parseDecisionRequest({ selection, proposalId, decision: 'approved' })).toEqual({ selection, proposalId, decision: 'approved' });
    expect(parseDecisionRequest({ selection, proposalId, decision: 'rejected', justification: '  a\r\nb ' })).toEqual({ selection, proposalId, decision: 'rejected', justification: 'a\nb' });
    expect(parseDecisionRequest({ selection, proposalId, decision: 'rejected', justification: '   ' })).toEqual({ selection, proposalId, decision: 'rejected' });
  });

  it.each<[string, unknown]>([
    ['nulo', null],
    ['lista', []],
    ['estado enviado pela janela', { selection, proposalId, decision: 'approved', state: 'ready-for-review' }],
    ['autorização enviada pela janela', { selection, proposalId, decision: 'approved', executable: true }],
    ['seleção com caminho', { selection: { ...selection, source: 'C:/segredo/Fulano' }, proposalId, decision: 'approved' }],
    ['seleção com campo extra', { selection: { ...selection, path: 'C:/segredo' }, proposalId, decision: 'approved' }],
    ['sem seleção', { proposalId, decision: 'approved' }],
    ['proposta com caminho', { selection, proposalId: '../../Fulano', decision: 'approved' }],
    ['decisão desconhecida', { selection, proposalId, decision: 'execute' }],
    ['decisão com outro tipo', { selection, proposalId, decision: true }],
    ['justificativa que não é texto', { selection, proposalId, decision: 'approved', justification: { x: 1 } }],
    ['justificativa longa demais', { selection, proposalId, decision: 'approved', justification: 'Fulano'.repeat(100) }],
    ['justificativa com controle', { selection, proposalId, decision: 'approved', justification: 'Fulano\u0007' }],
  ])('recusa %s, sem repetir o valor na mensagem', (_label, payload) => {
    expect(() => parseDecisionRequest(payload)).toThrow(InvalidInput);
    try {
      parseDecisionRequest(payload);
    } catch (error) {
      expect((error as Error).message).not.toMatch(/Fulano|segredo|execute|C:\//);
    }
  });

  it('sem análise, ou com proposta desconhecida, nada é registrado', async () => {
    const { selection: open1, inventoryId: id } = await open();
    const fresh = newController();
    await fresh.listInventories();
    await expect(fresh.decideProposal({ selection: open1, proposalId, decision: 'approved' })).rejects.toThrow(InvalidInput);
    await expect(fresh.revealDecisionNotes(id)).rejects.toThrow(InvalidInput);
    await expect(controller.decideProposal({ selection: open1, proposalId, decision: 'approved' })).rejects.toMatchObject({ code: 'proposal-not-found' });
    expect(await decisionFiles()).toEqual([]);
  });

  it('a API continua sem nada que escreva no AIR', () => {
    expect(API_METHODS).toContain('decideProposal');
    expect(API_METHODS.join(' ')).not.toMatch(/move|delete|remove|rename|merge|execute|create|approve/i);
  });

  it('sem a chave local: nada é registrado e a chave não é criada', async () => {
    const { selection: open1, view } = await open();
    await rm(path.join(base, 'air-organizer', 'checkpoint.key'));
    await expect(controller.decideProposal({ selection: open1, proposalId: readyFile(view).id, decision: 'approved' })).rejects.toMatchObject({ code: 'inventory-not-eligible' });
    expect(await decisionFiles()).toEqual([]);
    expect(await readdir(path.join(base, 'air-organizer'))).not.toContain('checkpoint.key');
  });
});

describe('privacidade', () => {
  const NOTE = 'Sigilosa: Fulano de Tal';

  it('visões, eventos e arquivo sem nomes; a justificativa só sai por pedido explícito', async () => {
    const { selection, view, inventoryId } = await open();
    const target = readyFile(view);
    const after = await controller.decideProposal({ selection, proposalId: target.id, decision: 'approved', justification: NOTE });
    const { notices: _n, ...rest } = after;
    expectNoNames(rest);
    expect(JSON.stringify(after)).not.toContain('Fulano');
    expect(JSON.stringify(events)).not.toContain('Fulano');
    expectNoNames(events);

    const text = (await readFile(await onlyDecisionFile(), 'utf-8')).replace(NOTE, '');
    expectNoNames(text);

    expect(await controller.revealDecisionNotes(inventoryId)).toEqual({ [target.id]: NOTE });
  });

  it('nova decisão sem justificativa encerra a anterior: só a vigente é revelada', () => {
    const base1 = { inventoryId: 'a', signature: 's', decidedAt: 'd', planning: { format: 'f', schemaVersion: 1, plannerVersion: '1', engineVersion: '1' }, executable: false as const, authorizesChanges: false as const };
    expect(
      latestJustifications([
        { ...base1, proposalId: 'M-1', decision: 'approved', justification: 'antiga' },
        { ...base1, proposalId: 'M-1', decision: 'rejected' },
        { ...base1, proposalId: 'M-2', decision: 'rejected', justification: 'vigente' },
      ]),
    ).toEqual({ 'M-2': 'vigente' });
  });

  it('recusa não expõe nomes nem o conteúdo do pedido', async () => {
    const { selection, view } = await open(CONFLICT());
    const failure = await controller.decideProposal({ selection, proposalId: blockedFile(view).id, decision: 'approved', justification: NOTE }).catch((e: unknown) => controller.describeError(e));
    expect(failure).toMatchObject({ code: 'decision-refused' });
    expectNoNames(failure);
    expect(JSON.stringify(failure)).not.toContain('Fulano');
  });

  it('resposta ao abrir com arquivo inválido não traz conteúdo dele', async () => {
    const { selection, inventoryId, d, inventoryFile } = await open();
    const plan = await planOf(inventoryFile, selection, d);
    await mkdir(decisionsDir(), { recursive: true });
    await writeFile(path.join(decisionsDir(), `${plan.source.inventoryId}.json`), `{"Fulano": "${NOTE}"`);
    await controller.inspectInventory(inventoryId);
    const after = await controller.previewProposals(selection);
    expect(after.decisions.file).toBe('invalid');
    expect(JSON.stringify(after)).not.toContain('Fulano');
    expect(await controller.revealDecisionNotes(inventoryId)).toEqual({});
  });
});
