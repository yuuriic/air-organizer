import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CheckpointFolder } from '../../src/core/checkpoint.js';
import { scanTree } from '../../src/core/tree-scanner.js';
import { assertFolderOpenTarget, OpenRefusedError, type FolderOpenTarget } from '../../src/safety/scope-validator.js';
import type { TreeLimits } from '../../src/types/inventory.js';
import { SimNavigator, file, files, folder, type SimBehavior, type SimNode } from '../sim-navigator.js';

/**
 * Pastas irmãs homônimas (dados SINTÉTICOS). Nenhuma informação da linha as distingue antes do
 * clique: cada uma é aberta pela sua linha (localizador temporário, revalidado) e identificada
 * depois pela URL própria. Duas linhas que levam à mesma pasta = identidade ambígua.
 */
const WIDE: TreeLimits = { maxDepth: 10, maxFolders: 100, maxItems: 10_000, maxPagesPerFolder: 50 };
const pseudonymize = (v: string) => createHmac('sha256', 'k').update(v).digest('hex').slice(0, 32);
/** Modo ainda não habilitado na CLI (depende de validação no AIR real): ativado explicitamente. */
const BY_URL = { homonyms: 'identify-by-url' } as const;
const scan = (root: SimNode, behavior?: SimBehavior, limits = WIDE) => {
  const nav = new SimNavigator(root, behavior);
  return { nav, run: scanTree(nav, limits, BY_URL) };
};
const twins = (a?: string, b?: string) =>
  folder('root', 'Raiz', [folder('h1', 'Contratos', files('a', 3), a), folder('h2', 'Contratos', [folder('h2x', 'Anexos'), file('b')], b), folder('ok', 'Outra')]);

describe('política padrão (a da CLI)', () => {
  it('homônimos exatos não são abertos (recusa segura); nomes que só diferem por caixa ou acento são', async () => {
    const root = folder('root', 'Raiz', [folder('h1', 'Contratos'), folder('h2', 'Contratos'), folder('a', 'ÓRBITAS'), folder('b', 'Orbitas')]);
    const nav = new SimNavigator(root);
    const r = await scanTree(nav, WIDE);
    expect(nav.opened()).toEqual(['a', 'b']);
    expect(r.folders.filter((f) => f.name === 'Contratos').map((f) => f.reasons)).toEqual([['homonym'], ['homonym']]);
    expect(r.status).toBe('partial');
  });
});

describe('homônimos: abertura individual e identidade pela URL', () => {
  it('duas irmãs com nomes idênticos e conteúdos diferentes: ambas abertas, distintas, inventário completo', async () => {
    const { nav, run } = scan(twins());
    const r = await run;
    expect(nav.opened()).toEqual(['h1', 'h2', 'h2x', 'ok']);
    expect(r.status).toBe('complete');
    expect(r.verification).toEqual({ contentRevalidated: true, eligibleForPlanning: true });
    const pair = r.folders.filter((f) => f.name === 'Contratos');
    expect(pair.map((f) => [f.status, f.counts.files, f.counts.folders])).toEqual([
      ['complete', 3, 0],
      ['complete', 1, 1],
    ]);
    expect(new Set(pair.map((f) => f.pageUrl)).size).toBe(2); // identidade persistente: URLs diferentes
  });

  it('volta sempre ao pai correto depois de cada homônimo', async () => {
    const { nav, run } = scan(twins());
    await run;
    expect(nav.log.filter((l) => !l.startsWith('scan:'))).toEqual(['open:h1', 'back:h1', 'open:h2', 'open:h2x', 'back:h2x', 'back:h2', 'open:ok', 'back:ok']);
  });

  it('nomes equivalentes por caixa ou acento não são ambíguos (título e caminho comparados exatamente)', async () => {
    const root = folder('root', 'Raiz', [folder('a', 'ÓRBITAS', [file('x')]), folder('b', 'Orbitas'), folder('c', 'orbitas', [file('y'), file('z')])]);
    const { nav, run } = scan(root);
    const r = await run;
    expect(nav.opened()).toEqual(['a', 'b', 'c']);
    expect(r.status).toBe('complete');
  });

  it('homônimos em páginas diferentes, com linhas distinguíveis (data): reposiciona e lê os dois', async () => {
    const { nav, run } = scan(twins('2026-01-01', '2026-02-01'), { pageSize: 1 });
    const r = await run;
    expect(nav.opened()).toEqual(['h1', 'h2', 'h2x', 'ok']);
    expect(r.status).toBe('complete');
    expect(r.folders.filter((f) => f.name === 'Contratos').map((f) => f.counts.pagesRead)).toEqual([3, 2]);
  });

  it('homônimos em páginas diferentes com linhas IDÊNTICAS: indistinguíveis de repetição da paginação, recusa segura', async () => {
    const { run } = scan(twins(), { pageSize: 1 });
    const r = await run;
    expect(r.status).toBe('partial');
    expect(r.folders[0]).toMatchObject({ status: 'partial', reasons: ['read-incomplete'] });
    expect(r.verification.eligibleForPlanning).toBe(false);
  });
});

describe('homônimos: recusa segura quando a identidade não é verificável', () => {
  it('duas linhas levam à mesma pasta: pendência homonym, inventário parcial', async () => {
    const { nav, run } = scan(twins(), { redirect: { h2: 'h1' } });
    const r = await run;
    expect(nav.log).toContain('back:h1');
    const second = r.folders.filter((f) => f.name === 'Contratos')[1]!;
    expect(second).toMatchObject({ status: 'skipped', reasons: ['homonym'] });
    expect(r.status).toBe('partial');
    expect(r.verification.eligibleForPlanning).toBe(false);
  });

  it('ordem dos itens muda entre a leitura e o clique: abertura recusada antes do clique', async () => {
    const { nav, run } = scan(twins('2026-01-01', '2026-02-01'), { reorderAfterScan: ['root'] });
    const r = await run;
    expect(nav.opened()).toEqual([]);
    expect(r.folders.filter((f) => f.depth === 1).every((f) => f.reasons.includes('open-refused'))).toBe(true);
    expect(r.status).toBe('partial');
  });

  it('navegação interrompida num homônimo: para sem novos cliques', async () => {
    const { nav, run } = scan(twins(), { lose: ['h2'] });
    const r = await run;
    expect(r).toMatchObject({ status: 'failed', abort: { reason: 'navigation-lost' } });
    expect(nav.log.at(-1)).toBe('open:h2');
  });

  it('trava antes do clique: homônimos só com a contagem lida do pai, e exatamente ela', () => {
    const base: FolderOpenTarget = { expectedName: 'Contratos', rowName: 'Contratos', cellText: 'Contratos', kind: 'folder', sameNameRows: 2, interactiveInCell: 0 };
    // Sem a contagem da leitura (ex.: opção 3, abertura avulsa): qualquer homônimo recusa.
    expect(() => assertFolderOpenTarget(base)).toThrow(expect.objectContaining({ code: 'homonym' }));
    expect(() => assertFolderOpenTarget({ ...base, expectedSameNameRows: 1 })).toThrow(OpenRefusedError);
    expect(() => assertFolderOpenTarget({ ...base, expectedSameNameRows: 2 })).not.toThrow();
    // Página com mais (ou menos) homônimos que a lida: a listagem mudou.
    expect(() => assertFolderOpenTarget({ ...base, sameNameRows: 3, expectedSameNameRows: 2 })).toThrow(expect.objectContaining({ code: 'row-changed' }));
    expect(() => assertFolderOpenTarget({ ...base, sameNameRows: 1, expectedSameNameRows: 2 })).toThrow(expect.objectContaining({ code: 'row-changed' }));
    // As demais verificações continuam valendo.
    expect(() => assertFolderOpenTarget({ ...base, expectedSameNameRows: 2, kind: 'file' })).toThrow(expect.objectContaining({ code: 'not-folder' }));
    expect(() => assertFolderOpenTarget({ ...base, expectedSameNameRows: 2, cellText: 'Outra' })).toThrow(expect.objectContaining({ code: 'row-changed' }));
  });
});

describe('homônimos e checkpoints', () => {
  async function firstRun(): Promise<CheckpointFolder[]> {
    let saved: CheckpointFolder[] = [];
    await scanTree(new SimNavigator(twins(), { lose: ['ok'] }), WIDE, { checkpoint: { pseudonymize, save: async (s) => void (saved = s.folders) }, ...BY_URL });
    return saved;
  }

  it('retomada VERIFICADA: cada homônimo é associado ao seu registro pela URL (comparado, não "novo")', async () => {
    const from = await firstRun();
    const r = await scanTree(new SimNavigator(twins()), WIDE, { checkpoint: { pseudonymize, save: async () => {}, resume: { from, mode: 'verified' } }, ...BY_URL });
    expect(r.status).toBe('complete');
    expect(r.folders.filter((f) => f.name === 'Contratos').map((f) => f.verification)).toEqual(['unchanged', 'unchanged']);
    expect(r.resume).toMatchObject({ mode: 'verified', reusedFolders: 0, removed: 0 });
  });

  it('retomada RÁPIDA nunca reaproveita homônimos sem reabrir (o registro não é associável antes do clique)', async () => {
    const from = await firstRun();
    const nav = new SimNavigator(twins());
    await scanTree(nav, WIDE, { checkpoint: { pseudonymize, save: async () => {}, resume: { from, mode: 'fast' } }, ...BY_URL });
    expect(nav.opened()).toEqual(expect.arrayContaining(['h1', 'h2']));
  });

  it('um de dois homônimos removido entre sessões conta como removido', async () => {
    const from = await firstRun();
    const one = folder('root', 'Raiz', [folder('h1', 'Contratos', files('a', 3)), folder('ok', 'Outra')]);
    const r = await scanTree(new SimNavigator(one), WIDE, { checkpoint: { pseudonymize, save: async () => {}, resume: { from, mode: 'verified' } }, ...BY_URL });
    expect(r.resume?.removed).toBe(1);
  });
});
