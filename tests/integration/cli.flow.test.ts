import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../fixtures/air-tree.js';

/**
 * A CLI real, com o menu e as respostas pela entrada padrão, sobre a fixture SINTÉTICA, com perfil,
 * chave e saídas em diretório temporário. Garante as opções 1 a 9 depois da extração para src/app.
 */
const ROOT = process.cwd();
const TIMEOUT = 150_000;
const dir = (id: string, name: string, children: TreeNode[] = []): TreeNode => ({ id, name, type: 'folder', children });
const doc = (id: string): TreeNode => ({ id, name: `documento ${id}.pdf`, type: 'file' });
const TREE = dir('root', 'Setor', [dir('o1', 'ORBITAS', [doc('a')]), dir('o2', 'Orbitas', [doc('b')]), dir('x', 'Alfa', [dir('y', 'Beta', [doc('c')])])]);

function runCli(base: string, cwd: string, answers: string[]): Promise<{ code: number | null; output: string }> {
  const env = { ...process.env, LOCALAPPDATA: path.join(base, 'local'), AIR_ORGANIZER_FIXTURE: JSON.stringify({ root: TREE, pageSize: 30 }) } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'AIR_ORGANIZER_PROFILE_DIR', 'AIR_ORGANIZER_CHECKPOINT_DIR', 'AIR_ORGANIZER_URL']) delete env[key];
  const preload = pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'cli-fixture-preload.ts')).href;
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--import', preload, path.join(ROOT, 'src', 'cli', 'index.ts'), '--url', 'https://air.fixture.test/air/my-air/root'], { cwd, env });
  let output = '';
  child.stdout.on('data', (d) => (output += String(d)));
  child.stderr.on('data', (d) => (output += String(d)));
  child.stdin.end(`${answers.join('\n')}\n`);
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, output })));
}

describe.runIf(process.platform === 'win32')('CLI depois da extração da camada compartilhada (dados sintéticos)', () => {
  it('opções 1 a 9: conexão, pasta, subpasta, duplicidades, exportação, árvore, retomada, diagnóstico e plano', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'air-organizer-desktop-cli-'));
    const cwd = path.join(base, 'cwd');
    await mkdir(cwd, { recursive: true });
    try {
      const { code, output } = await runCli(base, cwd, [
        '1', '', // conexão; Enter depois do "login"
        '2', 'Cliente Sintético', 'Setor Sintético', 's', // pasta atual
        '4', 'n', // duplicidades, sem nomes
        '5', 'n', // exporta só o diagnóstico
        '3', '3', '', '', 's', // subpasta "Alfa", ida e volta
        '6', '', '', '1', '2', '100', '5', 's', 'n', // árvore limitada a 2 pastas: parcial
        '7', '', '', '1', '1', '5', '50', '100', '5', 's', 's', // retomada VERIFICADA, inventário detalhado
        '8', '1', 'n', 'n', // diagnóstico
        '9', '1', 'n', 'n', // planejamento
        '0',
      ]);
      expect(code, output).toBe(0);
      for (const expected of [
        'Listagem:',
        'Colunas:',
        'Paginação:',
        'Cobertura:',
        'Status:             COMPLETA',
        'Suspeitas de duplicidade: 1 (opção 4)',
        'Retorno confirmado',
        'Resultado: PARCIAL',
        'Limites atingidos: max-folders',
        'a opção 7 retoma esta execução',
        '7. Retomar análise de árvore',
        'Modo de retomada: VERIFICADA',
        'Resultado: CONCLUÍDO',
        'Inventário detalhado selado',
        'Integridade:   AUTENTICADA',
        'Elegibilidade: ELEGÍVEL',
        'NÃO EXECUTÁVEIS',
      ]) expect(output).toContain(expected);
      expect(output).not.toContain('Erro (');
      // A opção 3 mostra dados identificáveis por projeto; árvore, retomada e análises, não.
      expect(output.slice(output.indexOf('Resultado: PARCIAL'))).not.toMatch(/ORBITAS|Orbitas|\.pdf|air\.fixture\.test/);

      const found: string[] = [];
      const walk = async (d: string) => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          if (e.isDirectory()) await walk(path.join(d, e.name));
          else found.push(path.join(d, e.name));
        }
      };
      await walk(path.join(cwd, 'output'));
      const names = found.map((f) => path.basename(f));
      for (const name of ['inventory-diagnostic.json', 'tree-diagnostic.json', 'tree-inventory.json', 'structural-diagnostics.json', 'organization-plan.json']) expect(names).toContain(name);
      const plan = JSON.parse(await readFile(found.find((f) => f.endsWith('organization-plan.json'))!, 'utf-8')) as { executable: boolean };
      expect(plan.executable).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  }, TIMEOUT);
});
