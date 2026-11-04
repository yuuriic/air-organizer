import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CheckpointFolder } from '../../src/core/checkpoint.js';
import { isResumable } from '../../src/core/checkpoint.js';
import { scanListing, type ListingSource } from '../../src/core/scanner.js';
import { scanTree } from '../../src/core/tree-scanner.js';
import type { PageSnapshot, ResumeMode, TreeEvent, TreeLimits, TreeResult } from '../../src/types/inventory.js';
import { row } from '../helpers.js';
import { SimNavigator, file, files, folder, type SimBehavior } from '../sim-navigator.js';

/** Parada controlada pelo operador (dados SINTÉTICOS). */
const WIDE: TreeLimits = { maxDepth: 10, maxFolders: 100, maxItems: 10_000, maxPagesPerFolder: 50 };
const pseudonymize = (v: string) => createHmac('sha256', 'k').update(v).digest('hex').slice(0, 32);
const tree = () => folder('root', 'Raiz', [folder('a', 'A', [folder('a1', 'A1', files('x', 1))]), folder('b', 'B', files('y', 2)), folder('c', 'C')]);
const byName = (r: TreeResult, name: string) => r.folders.find((f) => f.name === name)!;
/** Referências nascem na leitura do pai: Raiz F1; A F2; B F3; C F4; A1 F5. Ordem de leitura: F1, F2, F5, F3, F4. */

async function stoppedRun(when: (e: TreeEvent) => boolean, root = tree(), behavior?: SimBehavior) {
  const controller = new AbortController();
  let saved: CheckpointFolder[] = [];
  const nav = new SimNavigator(root, behavior);
  const result = await scanTree(nav, WIDE, {
    signal: controller.signal,
    onEvent: (e) => {
      if (when(e)) controller.abort();
    },
    checkpoint: { pseudonymize, save: async (s) => void (saved = s.folders) },
  });
  return { result, saved, nav };
}
const afterRead = (ref: string) => (e: TreeEvent) => e.type === 'folder-read' && e.ref === ref;

describe('parada entre pastas', () => {
  it('nenhum novo clique em subpasta; volta aos pais; resultado parcial e não elegível', async () => {
    const { result, nav } = await stoppedRun(afterRead('F2')); // F2 = A, recém-lida
    expect(nav.opened()).toEqual(['a']);
    expect(nav.log.at(-1)).toBe('back:a'); // terminou de volta na pasta inicial
    expect(result).toMatchObject({ status: 'partial', stopped: true });
    expect(result.abort).toBeUndefined();
    expect(result.verification.eligibleForPlanning).toBe(false);
    for (const name of ['A1', 'B', 'C']) expect(byName(result, name)).toMatchObject({ status: 'skipped', reasons: ['run-aborted'] });
    expect(byName(result, 'A')).toMatchObject({ status: 'complete', subtreeStatus: 'partial' });
    expect(byName(result, 'Raiz')).toMatchObject({ status: 'complete', subtreeStatus: 'partial' });
  });

  it('sinal já acionado: lê só a primeira página da pasta exibida e não clica em nada', async () => {
    const controller = new AbortController();
    controller.abort();
    const nav = new SimNavigator(tree());
    const r = await scanTree(nav, WIDE, { signal: controller.signal });
    expect(nav.opened()).toEqual([]);
    expect(r).toMatchObject({ status: 'partial', stopped: true });
  });

  it('sinal depois de tudo lido: resultado completo e sem "stopped"', async () => {
    const controller = new AbortController();
    const r = await scanTree(new SimNavigator(tree()), WIDE, {
      signal: controller.signal,
      onEvent: (e) => {
        if (afterRead('F4')(e)) controller.abort();
      },
    });
    expect(r.status).toBe('complete');
    expect(r.stopped).toBeUndefined();
  });

  it('pendências sem clique continuam com o motivo próprio', async () => {
    const root = folder('root', 'Raiz', [folder('h1', 'Docs'), folder('h2', 'Docs'), folder('ok', 'Ok')]);
    const { result } = await stoppedRun(afterRead('F1'), root);
    expect(result.folders.filter((f) => f.name === 'Docs').map((f) => f.reasons)).toEqual([['homonym'], ['homonym']]);
    expect(byName(result, 'Ok').reasons).toEqual(['run-aborted']);
  });

  it('falha ao voltar depois da parada continua sendo falha, não parada limpa', async () => {
    const { result, nav } = await stoppedRun(afterRead('F2'), tree(), { failBack: ['a'] });
    expect(result).toMatchObject({ status: 'failed', abort: { reason: 'return-failed' } });
    expect(nav.opened()).toEqual(['a']);
  });
});

describe('parada dentro de uma pasta paginada', () => {
  const pages = (n: number): PageSnapshot[] =>
    Array.from({ length: n }, (_, i) => ({ rows: [row(`item ${i + 1}.pdf`)], reportedTotal: n, pageRowCounter: 1, pageIndicator: `página ativa ${i + 1}` }));
  const source = (list: PageSnapshot[], onRead: (page: number) => void): ListingSource => {
    let at = 0;
    return {
      read: async () => (onRead(at + 1), list[at]!),
      next: async () => (at + 1 < list.length ? (at++, { status: 'moved' as const }) : { status: 'no-next' as const }),
      hasNext: async () => at + 1 < list.length,
    };
  };

  it('páginas restantes ficam não lidas e a listagem não é completa', async () => {
    const controller = new AbortController();
    const r = await scanListing(source(pages(4), (p) => p === 2 && controller.abort()), { maxPages: 50, readTimeoutMs: 500, signal: controller.signal });
    expect(r.pages).toHaveLength(2);
    expect(r.coverage).toMatchObject({ complete: false, stopReason: 'stopped', pagesRead: 2, unreadPages: [3, 4] });
    expect(r.coverage.issues.map((i) => i.kind)).toContain('stopped');
  });

  it('sinal na última página: leitura completa, nada a declarar', async () => {
    const controller = new AbortController();
    const r = await scanListing(source(pages(2), (p) => p === 2 && controller.abort()), { maxPages: 50, readTimeoutMs: 500, signal: controller.signal });
    expect(r.coverage).toMatchObject({ complete: true, stopReason: 'last-page' });
  });

  it('pasta parcialmente lida nunca é completa, e a subpasta das páginas lidas fica pendente', async () => {
    const root = folder('root', 'Raiz', [folder('sub', 'Sub', [folder('s1', 'S1'), folder('s2', 'S2'), folder('s3', 'S3')])]);
    const { result, saved } = await stoppedRun(afterRead('F1'), root, { pageSize: 1 });
    expect(result.status).toBe('partial');
    expect(byName(result, 'Raiz')).toMatchObject({ status: 'complete', subtreeStatus: 'partial' });
    expect(byName(result, 'Sub')).toMatchObject({ status: 'skipped', reasons: ['run-aborted'] });
    expect(isResumable(saved)).toBe(true);

    const controller = new AbortController();
    const nav = new SimNavigator(root, { pageSize: 1 });
    const r = await scanTree(nav, WIDE, {
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === 'progress') controller.abort();
      },
    });
    // Nada é lido além do sinal, mas a própria pasta só tem 1 página e foi lida inteira.
    expect(nav.opened()).toEqual([]);
    expect(r.stopped).toBe(true);
    expect(r.folders.find((f) => f.status === 'complete' && f.subtreeStatus === 'complete')).toBeUndefined();
  });

  it('parada no meio da paginação marca a própria pasta como parcial e retomável', async () => {
    const root = folder('root', 'Raiz', [file('f1'), file('f2'), file('f3')]);
    const controller = new AbortController();
    let saved: CheckpointFolder[] = [];
    const nav = new SimNavigator(root, { pageSize: 1 });
    const scan = nav.scan.bind(nav);
    nav.scan = (limits) => (controller.abort(), scan(limits));
    const r = await scanTree(nav, WIDE, { signal: controller.signal, checkpoint: { pseudonymize, save: async (s) => void (saved = s.folders) } });
    expect(r).toMatchObject({ status: 'partial', stopped: true });
    expect(r.folders[0]).toMatchObject({ status: 'partial', subtreeStatus: 'partial', reasons: ['read-incomplete'] });
    expect(r.folders[0]!.counts.pagesRead).toBe(1);
    expect(isResumable(saved)).toBe(true);
  });
});

describe('retomada depois da parada', () => {
  const resume = (from: CheckpointFolder[], mode: ResumeMode) => {
    const nav = new SimNavigator(tree());
    return { nav, run: scanTree(nav, WIDE, { checkpoint: { pseudonymize, save: async () => {}, resume: { from, mode } } }) };
  };

  it('VERIFICADA: relê tudo, inclusive o que ficou pendente, e fica completa e elegível', async () => {
    const { saved } = await stoppedRun(afterRead('F2'));
    expect(isResumable(saved)).toBe(true);
    const { nav, run } = resume(saved, 'verified');
    const r = await run;
    expect(nav.opened()).toEqual(['a', 'a1', 'b', 'c']);
    expect(r.status).toBe('complete');
    expect(r.stopped).toBeUndefined();
    expect(r.verification.eligibleForPlanning).toBe(true);
    expect(r.folders.every((f) => f.reasons.length === 0)).toBe(true);
  });

  it('RÁPIDA: não ignora pendências (abre o que faltou) e nunca fica elegível se reaproveitar', async () => {
    const { saved } = await stoppedRun(afterRead('F5')); // A e A1 lidas; B e C pendentes
    const { nav, run } = resume(saved, 'fast');
    const r = await run;
    expect(nav.opened()).toEqual(['b', 'c']);
    expect(r.resume!.reusedFolders).toBe(2);
    expect(r.folders.some((f) => f.reasons.includes('run-aborted'))).toBe(false);
    expect(r.status).toBe('complete');
    expect(r.verification.eligibleForPlanning).toBe(false);
  });

  it('o checkpoint da parada não guarda nomes', async () => {
    const { saved } = await stoppedRun(afterRead('F2'));
    expect(JSON.stringify(saved)).not.toMatch(/Raiz|"A1?"|A1|\bB\b/);
  });
});
