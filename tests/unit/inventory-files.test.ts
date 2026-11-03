import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeStructure } from '../../src/core/structural-diagnostics.js';
import { scanTree } from '../../src/core/tree-scanner.js';
import { SafetyViolation } from '../../src/safety/scope-validator.js';
import { exportTreeResult } from '../../src/storage/export.js';
import { describeLocalFailure, exportStructuralReport, listTreeInventories, readInventory } from '../../src/storage/inventory-files.js';
import type { AirEnvironment } from '../../src/types/inventory.js';
import { SimNavigator, folder } from '../sim-navigator.js';

const ENV: AirEnvironment = {
  instanceOrigin: { status: 'identified', value: 'https://air.exemplo.test', source: 'url' },
  pageUrl: { status: 'identified', value: 'https://air.exemplo.test/air/my-air/raiz', source: 'url' },
  client: { status: 'not-identified', reason: 'x' },
  sector: { status: 'identified', value: 'Setor Ficticio', source: 'operator' },
  currentFolder: { status: 'identified', value: 'Raiz', source: 'page-heading' },
  breadcrumb: { status: 'not-identified', reason: 'x' },
  observedAt: '2026-11-03T10:00:00.000Z',
};
const WIDE = { maxDepth: 5, maxFolders: 50, maxItems: 500, maxPagesPerFolder: 5 };

let out: string;
beforeEach(async () => {
  out = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-diag-'));
});
afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

async function exportRun(runId: string, finishedAt: string, detailed: boolean) {
  const root = folder('raiz', 'BELTRANA DE TAL', [folder('a', 'PLANETAS'), folder('b', 'Planetas')]);
  const result = await scanTree(new SimNavigator(root), WIDE);
  return exportTreeResult(result, { runId, startedAt: finishedAt, finishedAt, environment: ENV }, { detailed }, out);
}

describe('inventários exportados e relatório estrutural', () => {
  it('lista só tree-inventory.json (detalhados), do mais recente ao mais antigo', async () => {
    await exportRun('run-1', '2026-11-03T09:00:00.000Z', true);
    await exportRun('run-2', '2026-11-03T11:00:00.000Z', true);
    await exportRun('run-3', '2026-11-03T12:00:00.000Z', false); // só diagnóstico, sem nomes: não serve
    const list = await listTreeInventories(out);
    expect(list.map((e) => [path.basename(path.dirname(e.file)).slice(0, 5), e.finishedAt])).toEqual([
      ['run-2', '2026-11-03T11:00:00.000Z'],
      ['run-1', '2026-11-03T09:00:00.000Z'],
    ]);
  });

  it('do inventário exportado ao relatório: sem nomes por padrão; detalhado só com opção explícita', async () => {
    await exportRun('run-1', '2026-11-03T09:00:00.000Z', true);
    const [entry] = await listTreeInventories(out);
    const report = analyzeStructure(await readInventory(entry!.file, out), { now: new Date('2026-11-03T12:00:00.000Z') });
    expect(report.eligibility.status).toBe('exploratory'); // homônimos deixam a leitura parcial
    expect(report.findings.map((f) => f.rule)).toEqual(['DUP-SIBLING-NORMALIZED']);

    const [plain] = await exportStructuralReport(report, entry!.file, { detailed: false }, out);
    const text = await readFile(plain!, 'utf-8');
    expect(JSON.parse(text)).toMatchObject({ identifiable: false, summary: { findings: 1 } });
    for (const s of ['BELTRANA', 'PLANETAS', 'Planetas', 'exemplo.test', 'Setor Ficticio']) expect(text).not.toContain(s);

    const files = await exportStructuralReport(report, entry!.file, { detailed: true }, out);
    expect(files.map((f) => path.basename(f))).toEqual(['structural-diagnostics.json', 'structural-diagnostics-detailed.json']);
    expect(await readFile(files[1]!, 'utf-8')).toContain('PLANETAS');
    // O inventário de origem não é alterado.
    expect((await readdir(path.dirname(entry!.file))).sort()).toEqual(['structural-diagnostics-detailed.json', 'structural-diagnostics.json', 'tree-diagnostic.json', 'tree-inventory.json']);
  });

  it('arquivo ilegível é recusado pelo motor; caminho fora de output/ é bloqueado', async () => {
    const report = analyzeStructure(undefined, { now: new Date() });
    expect(report).toMatchObject({ eligibility: { status: 'rejected' }, findings: [] });
    await expect(readInventory(path.join(os.tmpdir(), 'outro.json'), out)).rejects.toThrow(SafetyViolation);
  });

  it('listagem não reproduz status nem data adulterados no inventário', async () => {
    const file = path.join(out, 'instancia', 'setor', 'run-adulterado', 'tree-inventory.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ status: 'Fulano de Tal 111.222.333-44', finishedAt: 'https://air.sigiloso.test/?token=TOKSECRETO999 2026' }), 'utf-8');
    expect(await listTreeInventories(out)).toEqual([{ file, status: 'desconhecido' }]);
  });

  it('falhas locais da opção 8 têm motivo próprio, sem navegador, caminhos nem trechos do arquivo', async () => {
    const file = path.join(out, 'BELTRANA DE TAL', 'setor', 'run-x', 'tree-inventory.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ "folders": [ { "name": "Fulano de Tal 111.222.333-44', 'utf-8');
    const failures = await Promise.all([
      readInventory(file, out).catch((e: unknown) => e),
      readInventory(path.join(path.dirname(file), 'removido.json'), out).catch((e: unknown) => e),
      readInventory(path.join(os.tmpdir(), 'BELTRANA.json'), out).catch((e: unknown) => e),
    ]);
    const messages = failures.map(describeLocalFailure);
    expect(messages[0]).toMatch(/não é um JSON válido/);
    expect(messages[1]).toMatch(/não encontrado/);
    expect(messages[2]).toMatch(/fora do diretório output/);
    expect(describeLocalFailure(Object.assign(new Error('x'), { code: 'EACCES' }))).toMatch(/permissão/);
    expect(describeLocalFailure(Object.assign(new Error('x'), { code: 'Fulano' }))).not.toContain('Fulano');
    for (const m of messages) for (const s of ['Chrome', 'navegador', 'BELTRANA', 'Fulano', '111.222', out]) expect(m).not.toContain(s);
  });

  it('JSON inválido continua visível e sua leitura falha explicitamente', async () => {
    const file = path.join(out, 'instancia', 'setor', 'run-invalido', 'tree-inventory.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ JSON incompleto', 'utf-8');

    expect(await listTreeInventories(out)).toEqual([{ file, status: 'inválido' }]);
    await expect(readInventory(file, out)).rejects.toThrow(SyntaxError);
  });
});
