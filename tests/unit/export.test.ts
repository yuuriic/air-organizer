import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findDuplicateSuspicions } from '../../src/core/duplicates.js';
import { parseRows } from '../../src/core/records.js';
import { displayPath, exportInventory, exportInventoryResult, exportTreeResult, inventoryPath, safeSegment } from '../../src/storage/export.js';
import type { Inventory, TreeResult } from '../../src/types/inventory.js';
import { row } from '../helpers.js';

function inventory(sector: Inventory['environment']['sector']): Inventory {
  return {
    schemaVersion: 1,
    tool: 'air-organizer',
    runId: '2026-10-29T10-00-00-000Z-abcd1234',
    mode: 'current-folder',
    readOnly: true,
    environment: {
      instanceOrigin: { status: 'identified', value: 'https://air.exemplo.test', source: 'url' },
      pageUrl: { status: 'identified', value: 'https://air.exemplo.test/p', source: 'url' },
      client: { status: 'not-identified', reason: 'x' },
      sector,
      currentFolder: { status: 'identified', value: 'Raiz', source: 'breadcrumb' },
      breadcrumb: { status: 'identified', value: ['Raiz'], source: 'breadcrumb' },
      observedAt: '2026-10-29T10:00:00.000Z',
    },
    startedAt: '2026-10-29T10:00:00.000Z',
    finishedAt: '2026-10-29T10:01:00.000Z',
    coverage: {
      pagesRead: 1,
      itemsObserved: 0,
      uniqueItems: 0,
      repeatedObservations: 0,
      unreadPages: [],
      complete: true,
      stopReason: 'last-page',
      issues: [],
    },
    items: [],
    duplicateSuspicions: [],
  };
}

let tempDir: string | undefined;
afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('safeSegment', () => {
  it('gera segmentos ASCII sem separadores e distingue rótulos parecidos', () => {
    expect(safeSegment('../../SETOR ALFA — Unidade')).toMatch(/^setor-alfa-unidade-[0-9a-f]{8}$/);
    expect(safeSegment('Setor A')).not.toBe(safeSegment('setor a'));
  });
});

describe('exportInventory', () => {
  it('separa por instância, setor e execução', () => {
    const file = inventoryPath(inventory({ status: 'identified', value: 'Setor X', source: 'operator' }), 'out');
    const parts = path.relative(path.resolve('out'), file).split(path.sep);
    expect(parts).toHaveLength(4);
    expect(parts[0]).toMatch(/^https-air-exemplo-test-/);
    expect(parts[1]).toMatch(/^setor-x-/);
    expect(parts[3]).toBe('inventory.json');
  });

  it('usa marcador explícito quando o setor não foi identificado', () => {
    const file = inventoryPath(inventory({ status: 'not-identified', reason: 'x' }), 'out');
    expect(file).toContain('setor-nao-identificado');
  });

  it('grava JSON válido apenas com metadados', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-'));
    const file = await exportInventory(inventory({ status: 'identified', value: 'Setor X', source: 'operator' }), tempDir);
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as Inventory;
    expect(parsed.readOnly).toBe(true);
    expect(parsed.environment.pageUrl).toMatchObject({ value: 'https://air.exemplo.test/p' });
    expect(JSON.stringify(parsed)).not.toMatch(/cookie|token|password|senha/i);
  });
});

describe('exportInventoryResult (opção 5)', () => {
  const sensitive = (): Inventory => {
    const base = inventory({ status: 'identified', value: 'Setor X', source: 'operator' });
    const items = parseRows(
      [row('BELTRANA DE TAL', { path: '/Meu Air/BELTRANA DE TAL' }, ['class=lucide-folder']), row('beltrana de tal', { path: '/Meu Air/beltrana de tal' }, ['class=lucide-folder'])],
      { pageNumber: 1, observedAt: 'x' },
    ).items;
    return {
      ...base,
      coverage: { ...base.coverage, complete: false, issues: [{ kind: 'scope-changed', pageNumber: 2, message: 'URL da pasta mudou de "https://air.exemplo.test/p"' }] },
      items,
      duplicateSuspicions: findDuplicateSuspicions(items),
    };
  };

  it('por padrão grava só o diagnóstico, sem nomes, caminhos, URLs, setor ou mensagens', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-'));
    const files = await exportInventoryResult(sensitive(), { detailed: false }, tempDir);
    expect(files.map((f) => path.basename(f))).toEqual(['inventory-diagnostic.json']);
    const text = await readFile(files[0]!, 'utf-8');
    for (const s of ['BELTRANA', 'beltrana', 'Meu Air', 'air.exemplo.test', 'Setor X', 'Raiz', 'URL da pasta']) expect(text).not.toContain(s);
    expect(JSON.parse(text)).toMatchObject({
      identifiable: false,
      environment: { instanceOrigin: 'identified', client: 'not-identified', sector: 'identified' },
      coverage: { complete: false, issues: [{ kind: 'scope-changed', pageNumber: 2 }] },
      itemKinds: { folder: 2 },
      duplicateSuspicions: { total: 1, byConfidence: { high: 1 } },
    });
  });

  it('inventário identificável só com opção explícita', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-'));
    const files = await exportInventoryResult(sensitive(), { detailed: true }, tempDir);
    expect(files.map((f) => path.basename(f))).toEqual(['inventory-diagnostic.json', 'inventory.json']);
    expect(await readFile(files[1]!, 'utf-8')).toContain('BELTRANA DE TAL');
  });

  it('o caminho exibido no console omite os segmentos de instância e setor', () => {
    const file = inventoryPath(inventory({ status: 'identified', value: 'Setor X', source: 'operator' }), 'output');
    const shown = displayPath(file);
    expect(shown).toMatch(/^output\/\*\/\*\/2026-10-29t10-00-00-000z-abcd1234-[0-9a-f]{8}\/inventory\.json$/);
    expect(shown).not.toMatch(/exemplo|setor-x/);
    expect(displayPath(path.resolve('elsewhere/x.json'))).toBe('(caminho omitido)');
  });
});

describe('exportTreeResult', () => {
  const env = inventory({ status: 'identified', value: 'Setor X', source: 'operator' }).environment;
  const meta = { runId: 'run-1', startedAt: 'a', finishedAt: 'b', environment: env };
  const result: TreeResult = {
    status: 'partial',
    limits: { maxDepth: 1, maxFolders: 2, maxItems: 10, maxPagesPerFolder: 1 },
    limitsReached: ['max-depth'],
    folders: [
      {
        ref: 'F1', depth: 0, status: 'complete', subtreeStatus: 'partial', reasons: [],
        counts: { items: 1, folders: 1, files: 0, unknown: 0, locationMismatch: 0, pagesRead: 1, unreadPages: [] }, issueKinds: [],
        name: 'BELTRANA DE TAL', path: '/Meu Air/BELTRANA DE TAL', pageUrl: 'https://air.exemplo.test/air/my-air/ID1',
        items: [], diagnostics: ['Breadcrumb de BELTRANA DE TAL'],
      },
    ],
    totals: { foldersRead: 1, foldersPending: 1, items: 1, folders: 1, files: 0, unknown: 0, pagesRead: 1 },
    verification: { contentRevalidated: true, eligibleForPlanning: false },
    navigation: { contentChanged: 0, identityMismatch: 0, navigationFailed: 0 },
  };

  it('por padrão grava só o diagnóstico, sem nomes, caminhos, URLs ou mensagens', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-'));
    const files = await exportTreeResult(result, meta, { detailed: false }, tempDir);
    expect(files.map((f) => path.basename(f))).toEqual(['tree-diagnostic.json']);
    const text = await readFile(files[0]!, 'utf-8');
    for (const s of ['BELTRANA', 'Meu Air', 'air.exemplo.test', 'Setor X', 'Breadcrumb']) expect(text).not.toContain(s);
    expect(JSON.parse(text)).toMatchObject({ identifiable: false, status: 'partial', folders: [{ ref: 'F1', subtreeStatus: 'partial' }] });
  });

  it('inventário detalhado só com opção explícita', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-'));
    const files = await exportTreeResult(result, meta, { detailed: true }, tempDir);
    expect(files.map((f) => path.basename(f))).toEqual(['tree-diagnostic.json', 'tree-inventory.json']);
    expect(await readFile(files[1]!, 'utf-8')).toContain('BELTRANA DE TAL');
  });
});
