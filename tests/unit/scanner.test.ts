import { describe, expect, it } from 'vitest';
import { pageSignature, scanListing } from '../../src/core/scanner.js';
import { pageOf, simulatedSource } from '../helpers.js';

const options = { maxPages: 50, readTimeoutMs: 200 };

function names(n: number, prefix = 'Pasta'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix} ${String(i + 1).padStart(3, '0')}`);
}

/** 65 itens em páginas de 30 → 3 páginas. */
function threePages() {
  const all = names(65);
  return [pageOf(all.slice(0, 30), 65), pageOf(all.slice(30, 60), 65), pageOf(all.slice(60), 65)];
}

describe('scanListing — paginação', () => {
  it('lê todas as páginas até o fim e reporta cobertura completa', async () => {
    const source = simulatedSource(threePages());
    const { items, pages, coverage } = await scanListing(source, options);
    expect(items).toHaveLength(65);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(source.clicks).toBe(2);
    expect(coverage).toMatchObject({
      pagesRead: 3,
      expectedPages: 3,
      uniqueItems: 65,
      itemsObserved: 65,
      repeatedObservations: 0,
      reportedTotal: 65,
      unreadPages: [],
      stopReason: 'last-page',
      complete: true,
      issues: [],
    });
    expect(items.map((i) => i.sourcePage)).toEqual([...Array(30).fill(1), ...Array(30).fill(2), ...Array(5).fill(3)]);
  });

  it('página única sem paginação', async () => {
    const { coverage } = await scanListing(simulatedSource([pageOf(names(18), 18)]), options);
    expect(coverage).toMatchObject({ pagesRead: 1, uniqueItems: 18, complete: true, stopReason: 'last-page' });
  });

  it('listagem vazia é lida como completa', async () => {
    const { items, coverage } = await scanListing(simulatedSource([pageOf([], 0)]), options);
    expect(items).toEqual([]);
    expect(coverage.complete).toBe(true);
  });

  it('não descarta homônimos legítimos em páginas diferentes com metadados distintos', async () => {
    const p1 = pageOf(['Cometas']);
    const p2 = { rows: [{ ...p1.rows[0]!, cells: { ...p1.rows[0]!.cells, 'Data criação': '05/05/2025' } }] };
    const { items, coverage } = await scanListing(simulatedSource([p1, p2]), options);
    expect(items).toHaveLength(2);
    expect(coverage.repeatedObservations).toBe(0);
  });
});

describe('scanListing — loops e falhas', () => {
  it('detecta loop quando uma página volta a exibir conteúdo já lido', async () => {
    const pages = threePages();
    const { items, coverage } = await scanListing(simulatedSource(pages, {}, [0, 1, 0, 2]), options);
    expect(coverage.stopReason).toBe('loop');
    expect(coverage.complete).toBe(false);
    expect(coverage.issues.map((i) => i.kind)).toContain('loop-detected');
    expect(coverage.unreadPages).toEqual([3]);
    expect(items).toHaveLength(60);
  });

  it('para quando a listagem não muda após avançar', async () => {
    const { coverage } = await scanListing(simulatedSource(threePages(), { nextOverride: { 1: { status: 'unchanged' } } }), options);
    expect(coverage).toMatchObject({ pagesRead: 1, stopReason: 'error', complete: false });
    expect(coverage.issues[0]?.kind).toBe('page-unchanged');
  });

  it('para em timeout de navegação e lista páginas não lidas quando estimável', async () => {
    const { coverage } = await scanListing(simulatedSource(threePages(), { nextOverride: { 2: { status: 'timeout' } } }), options);
    expect(coverage).toMatchObject({ pagesRead: 2, stopReason: 'timeout', complete: false, unreadPages: [3] });
  });

  it('para em timeout de leitura sem travar', async () => {
    const started = Date.now();
    const { items, coverage } = await scanListing(simulatedSource(threePages(), { hangOnPage: 2 }), options);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(items).toHaveLength(30);
    expect(coverage).toMatchObject({ stopReason: 'timeout', complete: false, unreadPages: [] });
    expect(coverage.issues[0]).toMatchObject({ kind: 'timeout', pageNumber: 2 });
  });

  it('registra erro de leitura e mantém o que já foi lido', async () => {
    const { items, coverage } = await scanListing(simulatedSource(threePages(), { failReadOnPage: 3 }), options);
    expect(items).toHaveLength(60);
    expect(coverage.issues[0]).toMatchObject({ kind: 'read-error', pageNumber: 3 });
  });

  it('registra erro de navegação', async () => {
    const { coverage } = await scanListing(simulatedSource(threePages(), { nextOverride: { 1: new Error('clique falhou') } }), options);
    expect(coverage.issues[0]).toMatchObject({ kind: 'navigation-error', message: 'clique falhou' });
    expect(coverage.stopReason).toBe('error');
  });

  it('respeita o limite máximo de páginas', async () => {
    const { coverage } = await scanListing(simulatedSource(threePages()), { ...options, maxPages: 2 });
    expect(coverage).toMatchObject({ pagesRead: 2, stopReason: 'max-pages', complete: false, unreadPages: [3] });
  });

  it('interrompe quando o escopo (setor/breadcrumb) muda', async () => {
    const source = simulatedSource(threePages(), { scopeProblemsOnPage: { 2: ['Breadcrumb mudou'] } });
    const { coverage } = await scanListing(source, options);
    expect(coverage).toMatchObject({ pagesRead: 2, stopReason: 'scope-changed', complete: false });
    expect(source.clicks).toBe(1);
  });
});

describe('scanListing — consistência de contagem', () => {
  it('conta repetições entre páginas sem duplicar itens e marca como parcial', async () => {
    const all = names(4);
    const pages = [pageOf(all.slice(0, 3), 4), pageOf([all[2]!, all[3]!], 4)];
    const { items, coverage } = await scanListing(simulatedSource(pages), options);
    expect(items.map((i) => i.name)).toEqual(all);
    expect(coverage).toMatchObject({ itemsObserved: 5, uniqueItems: 4, repeatedObservations: 1, complete: false });
  });

  it('marca divergência entre itens lidos e total exibido', async () => {
    const { coverage } = await scanListing(simulatedSource([pageOf(names(18), 20)]), options);
    expect(coverage.complete).toBe(false);
    expect(coverage.issues.map((i) => i.kind)).toContain('count-mismatch');
  });

  it('regressão POC-01B: paginador não reconhecido com total 37 no título NÃO é completo', async () => {
    // AIR real: 30 linhas na página 1 ("0 de 30 linhas(s)"), "Meu Air (37)", próxima página não encontrada.
    const page1 = { ...pageOf(names(30), 37), pageRowCounter: 30 };
    const { coverage } = await scanListing(simulatedSource([page1]), options);
    expect(coverage).toMatchObject({ pagesRead: 1, uniqueItems: 30, reportedTotal: 37, complete: false, stopReason: 'last-page' });
    expect(coverage.issues.map((i) => i.kind)).toContain('count-mismatch');
  });

  it('marca divergência quando o contador da página difere das linhas lidas', async () => {
    const page1 = { ...pageOf(names(28), 28), pageRowCounter: 30 };
    const { coverage } = await scanListing(simulatedSource([page1]), options);
    expect(coverage.complete).toBe(false);
    expect(coverage.issues.find((i) => i.kind === 'count-mismatch')?.message).toMatch(/contador da página indica 30/);
  });

  it('sem total exibido, não inventa páginas esperadas', async () => {
    const { coverage } = await scanListing(simulatedSource([pageOf(names(30)), pageOf(names(5, 'Outro'))]), options);
    expect(coverage.expectedPages).toBeUndefined();
    expect(coverage.reportedTotal).toBeUndefined();
    expect(coverage.complete).toBe(true);
  });
});

describe('pageSignature', () => {
  it('muda quando qualquer célula muda, não apenas o nome', () => {
    const a = pageOf(['A']);
    const b = { rows: [{ ...a.rows[0]!, cells: { ...a.rows[0]!.cells, Status: 'Arquivado' } }] };
    expect(pageSignature(a)).not.toBe(pageSignature(b));
    expect(pageSignature(a)).toBe(pageSignature(pageOf(['A'])));
  });
});
