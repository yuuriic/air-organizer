import { describe, expect, it } from 'vitest';
import { scanListing, type ListingSource } from '../../src/core/scanner.js';
import { diagnosticReport, formatTreeEvent, scanTree, type ChildRef, type FolderView, type TreeNavigator } from '../../src/core/tree-scanner.js';
import { OpenRefusedError } from '../../src/safety/scope-validator.js';
import type { PageSnapshot, ScanResult, TreeEvent, TreeLimits } from '../../src/types/inventory.js';
import { row } from '../helpers.js';

type SimNode = { id: string; name: string; type: 'folder' | 'file' | 'unknown'; children?: SimNode[] };

type Behavior = {
  pageSize?: number;
  /** Recusa antes do clique ao abrir estes ids. */
  refuse?: string[];
  /** Erro depois do clique ao abrir estes ids. */
  lose?: string[];
  /** Falha ao voltar destes ids. */
  failBack?: string[];
  /** Abrir o id da chave exibe o nó do valor (ciclos / visitas repetidas). */
  redirect?: Record<string, string>;
};

const folder = (id: string, name: string, children: SimNode[] = []): SimNode => ({ id, name, type: 'folder', children });
const file = (id: string, name = `${id}.pdf`): SimNode => ({ id, name, type: 'file' });
const files = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => file(`${prefix}${i}`));

/** Navegador simulado: árvore em memória, leitura pelo scanner real, registro de cada ação. */
class SimNavigator implements TreeNavigator {
  readonly log: string[] = [];
  private readonly stack: SimNode[];
  private readonly byId = new Map<string, SimNode>();
  private readonly parent = new Map<string, SimNode>();

  constructor(
    root: SimNode,
    private readonly behavior: Behavior = {},
  ) {
    const index = (n: SimNode, p?: SimNode) => {
      this.byId.set(n.id, n);
      if (p) this.parent.set(n.id, p);
      for (const c of n.children ?? []) index(c, n);
    };
    index(root);
    this.stack = [root];
  }

  private top(): SimNode {
    return this.stack[this.stack.length - 1]!;
  }

  private pathOf(n: SimNode): string {
    const names: string[] = [];
    for (let x: SimNode | undefined = n; x; x = this.parent.get(x.id)) names.unshift(x.name);
    return `/${names.join('/')}`;
  }

  private viewOf(n: SimNode): FolderView {
    return { key: `https://air.test/air/my-air/${n.id}`, title: n.name, total: n.children?.length ?? 0, path: this.pathOf(n) };
  }

  async current() {
    return this.viewOf(this.top());
  }

  async scan(limits: { maxPages: number; maxItems: number }): Promise<ScanResult> {
    const node = this.top();
    const kids = node.children ?? [];
    const size = this.behavior.pageSize ?? 30;
    const pages: PageSnapshot[] = [];
    for (let i = 0; i < Math.max(1, Math.ceil(kids.length / size)); i++) {
      const slice = kids.slice(i * size, (i + 1) * size);
      pages.push({
        rows: slice.map((k) => ({
          ...row(k.name, { path: this.pathOf(node) }),
          typeIcon: k.type === 'folder' ? 'folder' : k.type === 'file' ? 'img:pdf icon' : '',
        })),
        reportedTotal: kids.length,
        pageRowCounter: slice.length,
        pageIndicator: `página ativa ${i + 1}`,
      });
    }
    let position = 0;
    const source: ListingSource = {
      read: async () => pages[position]!,
      next: async () => {
        if (position + 1 >= pages.length) return { status: 'no-next' };
        position++;
        this.log.push(`next:${node.id}`);
        return { status: 'moved' };
      },
      hasNext: async () => position + 1 < pages.length,
    };
    this.log.push(`scan:${node.id}`);
    return scanListing(source, { maxPages: limits.maxPages, maxItems: limits.maxItems, readTimeoutMs: 500 });
  }

  async open(parent: FolderView, _scan: ScanResult, child: ChildRef): Promise<FolderView> {
    if (parent.key !== this.viewOf(this.top()).key) throw new Error('simulação: pai não é a pasta exibida');
    const target = (this.top().children ?? []).find((c) => c.name === child.name);
    if (!target || target.type !== 'folder') throw new OpenRefusedError('not-folder', `simulação: ${child.name} não é pasta`);
    if (this.behavior.refuse?.includes(target.id)) throw new OpenRefusedError('row-changed', `linha mudou: ${child.name}`);
    this.log.push(`open:${target.id}`);
    if (this.behavior.lose?.includes(target.id)) throw new Error(`perdido ao abrir ${child.name}`);
    const shown = this.byId.get(this.behavior.redirect?.[target.id] ?? target.id)!;
    this.stack.push(shown);
    return this.viewOf(shown);
  }

  async back(child: FolderView, parent: FolderView): Promise<void> {
    const node = this.top();
    if (this.viewOf(node).key !== child.key) throw new Error('simulação: filho não é a pasta exibida');
    if (this.behavior.failBack?.includes(node.id)) throw new Error(`falha ao voltar de ${node.name}`);
    this.stack.pop();
    this.log.push(`back:${node.id}`);
    if (this.viewOf(this.top()).key !== parent.key) throw new Error('simulação: voltou para outra pasta');
  }

  opened(): string[] {
    return this.log.filter((l) => l.startsWith('open:')).map((l) => l.slice(5));
  }
}

const WIDE: TreeLimits = { maxDepth: 10, maxFolders: 100, maxItems: 10_000, maxPagesPerFolder: 50 };

/** Raiz → A (A1 → arquivo; arquivo), B (vazia), arquivo. */
function tree(): SimNode {
  return folder('root', 'Raiz', [folder('a', 'A', [folder('a1', 'A1', [file('f1')]), file('f2')]), folder('b', 'B'), file('f3')]);
}

const byRef = (r: Awaited<ReturnType<typeof scanTree>>, name: string) => r.folders.find((f) => f.name === name)!;

describe('scanTree — percurso', () => {
  it('percorre vários níveis em profundidade, volta sempre ao pai e declara completo', async () => {
    const nav = new SimNavigator(tree());
    const r = await scanTree(nav, WIDE);
    expect(nav.log).toEqual(['scan:root', 'open:a', 'scan:a', 'open:a1', 'scan:a1', 'back:a1', 'back:a', 'open:b', 'scan:b', 'back:b']);
    expect(r.status).toBe('complete');
    expect(r.folders.map((f) => [f.ref, f.parentRef, f.depth, f.name, f.status, f.subtreeStatus])).toEqual([
      ['F1', undefined, 0, 'Raiz', 'complete', 'complete'],
      ['F2', 'F1', 1, 'A', 'complete', 'complete'],
      ['F3', 'F1', 1, 'B', 'complete', 'complete'],
      ['F4', 'F2', 2, 'A1', 'complete', 'complete'],
    ]);
    expect(r.totals).toEqual({ foldersRead: 4, foldersPending: 0, items: 6, folders: 3, files: 3, unknown: 0 });
  });

  it('pasta vazia é lida como completa', async () => {
    const r = await scanTree(new SimNavigator(folder('root', 'Raiz', [folder('v', 'Vazia')])), WIDE);
    expect(r.status).toBe('complete');
    expect(byRef(r, 'Vazia')).toMatchObject({ status: 'complete', counts: { items: 0 } });
  });

  it('nunca abre arquivos', async () => {
    const nav = new SimNavigator(tree());
    await scanTree(nav, WIDE);
    expect(nav.opened()).toEqual(['a', 'a1', 'b']);
  });
});

describe('scanTree — identidade e pendências', () => {
  it('homônimos (inclusive pasta x arquivo com nome equivalente) não são abertos e ficam pendentes', async () => {
    const root = folder('root', 'Raiz', [folder('x1', 'Docs'), folder('x2', 'docs'), folder('y', 'Notas'), file('n', 'NOTAS'), folder('ok', 'Outra')]);
    const nav = new SimNavigator(root);
    const r = await scanTree(nav, WIDE);
    expect(nav.opened()).toEqual(['ok']);
    expect(['Docs', 'docs', 'Notas'].map((n) => byRef(r, n).reasons)).toEqual([['homonym'], ['homonym'], ['homonym']]);
    expect(r.status).toBe('partial');
    expect(byRef(r, 'Raiz')).toMatchObject({ status: 'complete', subtreeStatus: 'partial' });
  });

  it('item de tipo desconhecido não é aberto e torna a subárvore parcial', async () => {
    const nav = new SimNavigator(folder('root', 'Raiz', [{ id: 'u', name: 'Talvez pasta', type: 'unknown' }]));
    const r = await scanTree(nav, WIDE);
    expect(nav.opened()).toEqual([]);
    expect(byRef(r, 'Raiz')).toMatchObject({ status: 'complete', subtreeStatus: 'partial', reasons: ['unknown-items'], counts: { unknown: 1 } });
    expect(r.status).toBe('partial');
  });

  it('recusa antes do clique: registra a falha e continua com as irmãs', async () => {
    const nav = new SimNavigator(tree(), { refuse: ['a'] });
    const r = await scanTree(nav, WIDE);
    expect(byRef(r, 'A')).toMatchObject({ status: 'failed', reasons: ['open-refused'], refusal: 'row-changed' });
    expect(nav.opened()).toEqual(['b']);
    expect(r.status).toBe('partial');
  });

  it('falha depois de abrir: interrompe tudo sem novos cliques e preserva o diagnóstico', async () => {
    const nav = new SimNavigator(tree(), { lose: ['a1'] });
    const r = await scanTree(nav, WIDE);
    expect(nav.log).toEqual(['scan:root', 'open:a', 'scan:a', 'open:a1']); // nem "voltar" depois da perda
    expect(r.status).toBe('failed');
    expect(r.abort).toEqual({ reason: 'navigation-lost', atRef: 'F4', message: 'perdido ao abrir A1' });
    expect(byRef(r, 'B')).toMatchObject({ status: 'skipped', reasons: ['run-aborted'] });
    expect(byRef(r, 'A').subtreeStatus).toBe('partial');
  });

  it('falha ao voltar: interrompe tudo e marca o restante como pendente', async () => {
    const nav = new SimNavigator(tree(), { failBack: ['a1'] });
    const r = await scanTree(nav, WIDE);
    expect(nav.log.at(-1)).toBe('scan:a1');
    expect(r).toMatchObject({ status: 'failed', abort: { reason: 'return-failed', atRef: 'F4' } });
    expect(byRef(r, 'A')).toMatchObject({ reasons: ['return-failed'], subtreeStatus: 'partial' });
    expect(byRef(r, 'B').reasons).toEqual(['run-aborted']);
  });

  it('detecta ciclo (subpasta exibe um ancestral) e não relê', async () => {
    const nav = new SimNavigator(tree(), { redirect: { a1: 'root' } });
    const r = await scanTree(nav, WIDE);
    expect(byRef(r, 'A1')).toMatchObject({ status: 'failed', reasons: ['cycle'] });
    expect(nav.log.filter((l) => l === 'scan:root')).toHaveLength(1);
    expect(nav.log).toContain('back:root'); // volta normalmente ao pai
    expect(r.status).toBe('partial');
  });

  it('detecta visita repetida (duas linhas levam à mesma pasta) e não relê', async () => {
    const nav = new SimNavigator(tree(), { redirect: { b: 'a' } });
    const r = await scanTree(nav, WIDE);
    expect(byRef(r, 'B')).toMatchObject({ status: 'skipped', reasons: ['repeated-visit'] });
    expect(nav.log.filter((l) => l === 'scan:a')).toHaveLength(1);
    expect(r.status).toBe('partial');
  });

  it('propaga parcial de um nível profundo até a raiz sem rebaixar o status próprio', async () => {
    const root = folder('root', 'Raiz', [folder('a', 'A', [folder('a1', 'A1', [{ id: 'u', name: '?', type: 'unknown' }])])]);
    const r = await scanTree(new SimNavigator(root), WIDE);
    expect(r.folders.map((f) => [f.name, f.status, f.subtreeStatus])).toEqual([
      ['Raiz', 'complete', 'partial'],
      ['A', 'complete', 'partial'],
      ['A1', 'complete', 'partial'],
    ]);
  });
});

describe('scanTree — limites', () => {
  it('maxDepth: não abre além da profundidade e registra pendência', async () => {
    const nav = new SimNavigator(tree());
    const r = await scanTree(nav, { ...WIDE, maxDepth: 1 });
    expect(nav.opened()).toEqual(['a', 'b']);
    expect(byRef(r, 'A1')).toMatchObject({ status: 'skipped', reasons: ['max-depth'] });
    expect(r).toMatchObject({ status: 'partial', limitsReached: ['max-depth'] });
  });

  it('maxDepth 0: só a pasta inicial', async () => {
    const nav = new SimNavigator(tree());
    const r = await scanTree(nav, { ...WIDE, maxDepth: 0 });
    expect(nav.opened()).toEqual([]);
    expect(r.status).toBe('partial');
  });

  it('maxFolders: conta a pasta inicial e para de abrir ao atingir o limite', async () => {
    const nav = new SimNavigator(tree());
    const r = await scanTree(nav, { ...WIDE, maxFolders: 2 });
    expect(nav.opened()).toEqual(['a']);
    expect(['A1', 'B'].map((n) => byRef(r, n).reasons)).toEqual([['max-folders'], ['max-folders']]);
    expect(r.totals.foldersRead).toBe(2);
    expect(r.limitsReached).toEqual(['max-folders']);
  });

  it('maxItems: interrompe a leitura da pasta na fronteira de página e não abre mais pastas', async () => {
    const root = folder('root', 'Raiz', [folder('a', 'A', files('a', 70)), folder('b', 'B', [file('b1')])]);
    const nav = new SimNavigator(root);
    const r = await scanTree(nav, { ...WIDE, maxItems: 40 });
    expect(byRef(r, 'A')).toMatchObject({ status: 'partial', reasons: ['max-items'], counts: { items: 60, pagesRead: 2 } });
    expect(byRef(r, 'B')).toMatchObject({ status: 'skipped', reasons: ['max-items'] });
    expect(nav.opened()).toEqual(['a']);
    expect(r.status).toBe('partial');
  });

  it('maxPagesPerFolder: paginação em subpasta, parcial ao exceder e completa no limite exato', async () => {
    const root = folder('root', 'Raiz', [folder('a', 'A', files('a', 65)), folder('b', 'B', files('b', 60))]);
    const r = await scanTree(new SimNavigator(root), { ...WIDE, maxPagesPerFolder: 2 });
    expect(byRef(r, 'A')).toMatchObject({ status: 'partial', reasons: ['max-pages'], counts: { items: 60, pagesRead: 2 } });
    expect(byRef(r, 'B')).toMatchObject({ status: 'complete', counts: { items: 60, pagesRead: 2 } });
    expect(r.limitsReached).toEqual(['max-pages']);
  });

  it('subpasta com várias páginas é lida inteira dentro dos limites', async () => {
    const root = folder('root', 'Raiz', [folder('a', 'A', files('a', 65))]);
    const nav = new SimNavigator(root);
    const r = await scanTree(nav, WIDE);
    expect(byRef(r, 'A')).toMatchObject({ status: 'complete', counts: { items: 65, pagesRead: 3 } });
    expect(nav.log.filter((l) => l === 'next:a')).toHaveLength(2);
  });

  it('recusa limites inválidos', async () => {
    await expect(scanTree(new SimNavigator(tree()), { ...WIDE, maxFolders: 0 })).rejects.toThrow(/maxFolders/);
    await expect(scanTree(new SimNavigator(tree()), { ...WIDE, maxDepth: -1 })).rejects.toThrow(/maxDepth/);
  });
});

describe('scanTree — privacidade', () => {
  it('logs padrão e relatório diagnóstico não contêm nomes, caminhos nem URLs', async () => {
    const secret = ['BELTRANA DE TAL', 'REGISTRO 111.222.333-44', 'REG-XX 00000 - CICRANO'];
    const root = folder('root', secret[0]!, [folder('p', secret[1]!, [file('x', `${secret[2]}.pdf`), { id: 'u', name: secret[2]!, type: 'unknown' }]), folder('q', 'Q', [])]);
    const events: TreeEvent[] = [];
    const r = await scanTree(new SimNavigator(root, { lose: ['q'] }), WIDE, { onEvent: (e) => events.push(e) });
    const exposed = [...events.map(formatTreeEvent), JSON.stringify(events), JSON.stringify(diagnosticReport(r))].join('\n');
    for (const s of [...secret, 'air.test', '/']) expect(exposed).not.toContain(s);
    // O resultado em memória mantém os dados (para exportação detalhada só com confirmação).
    expect(JSON.stringify(r)).toContain(secret[1]);
  });
});
