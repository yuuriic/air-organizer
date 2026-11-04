import { scanListing, type ListingSource } from '../src/core/scanner.js';
import type { BackOutcome, ChildRef, FolderView, TreeNavigator } from '../src/core/tree-scanner.js';
import { OpenRefusedError } from '../src/safety/scope-validator.js';
import type { PageSnapshot, ScanResult } from '../src/types/inventory.js';
import { row } from './helpers.js';

/** `createdAt` permite simular mudança de metadados da linha entre sessões. */
export type SimNode = { id: string; name: string; type: 'folder' | 'file' | 'unknown'; children?: SimNode[]; createdAt?: string };

export type SimBehavior = {
  pageSize?: number;
  /** Recusa antes do clique ao abrir estes ids. */
  refuse?: string[];
  /** Erro depois do clique ao abrir estes ids. */
  lose?: string[];
  /** Falha ao voltar destes ids. */
  failBack?: string[];
  /** Abrir o id da chave exibe o nó do valor (ciclos / visitas repetidas). */
  redirect?: Record<string, string>;
  /** Ao voltar destes ids, o pai está com identidade confirmada mas conteúdo divergente (ADR-013). */
  changeOnBack?: Record<string, { total: boolean; listing: boolean }>;
  /** Logo depois de ler estes ids, a ordem dos filhos é invertida (listagem muda antes do clique). */
  reorderAfterScan?: string[];
};

export const folder = (id: string, name: string, children: SimNode[] = [], createdAt?: string): SimNode => ({
  id,
  name,
  type: 'folder',
  children,
  ...(createdAt ? { createdAt } : {}),
});
export const file = (id: string, name = `${id}.pdf`): SimNode => ({ id, name, type: 'file' });
export const files = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => file(`${prefix}${i}`));

/** Navegador simulado: árvore em memória, leitura pelo scanner real, registro de cada ação. */
export class SimNavigator implements TreeNavigator {
  readonly log: string[] = [];
  private readonly stack: SimNode[];
  private readonly byId = new Map<string, SimNode>();
  private readonly parent = new Map<string, SimNode>();
  /** Páginas lidas por pasta (nome + data de cada linha): o "reposicionar" do adaptador real as compara. */
  private readonly scanned = new Map<string, string[][]>();

  constructor(
    root: SimNode,
    private readonly behavior: SimBehavior = {},
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
          ...row(k.name, { path: this.pathOf(node), ...(k.createdAt ? { createdAt: k.createdAt } : {}) }),
          typeIcon: k.type === 'folder' ? 'folder' : k.type === 'file' ? 'img:pdf icon' : '',
        })),
        reportedTotal: kids.length,
        pageRowCounter: slice.length,
        pageIndicator: `página ativa ${i + 1}`,
      });
    }
    this.scanned.set(node.id, pages.map((_, i) => this.pageRows(node, i)));
    if (this.behavior.reorderAfterScan?.includes(node.id)) node.children = [...kids].reverse();
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

  private pageRows(node: SimNode, page: number): string[] {
    const size = this.behavior.pageSize ?? 30;
    return (node.children ?? []).slice(page * size, (page + 1) * size).map((k) => `${k.type}|${k.name}|${k.createdAt ?? ''}`);
  }

  /**
   * Como o adaptador real: a linha (página + índice) é só um localizador temporário. Antes do
   * clique, a página precisa ser idêntica à lida (assinatura) e a linha ter o nome esperado.
   */
  async open(parent: FolderView, _scan: ScanResult, child: ChildRef): Promise<FolderView> {
    if (parent.key !== this.viewOf(this.top()).key) throw new Error('simulação: pai não é a pasta exibida');
    const node = this.top();
    const page = child.sourcePage - 1;
    if (this.scanned.get(node.id)?.[page]?.join('\n') !== this.pageRows(node, page).join('\n')) {
      throw new OpenRefusedError('precondition', `simulação: página ${child.sourcePage} difere da lida`);
    }
    const target = (node.children ?? [])[page * (this.behavior.pageSize ?? 30) + child.rowIndex];
    if (!target || target.name !== child.name) throw new OpenRefusedError('row-changed', `simulação: linha de ${child.name} mudou`);
    if (target.type !== 'folder') throw new OpenRefusedError('not-folder', `simulação: ${child.name} não é pasta`);
    if (this.behavior.refuse?.includes(target.id)) throw new OpenRefusedError('row-changed', `linha mudou: ${child.name}`);
    this.log.push(`open:${target.id}`);
    if (this.behavior.lose?.includes(target.id)) throw new Error(`perdido ao abrir ${child.name}`);
    const shown = this.byId.get(this.behavior.redirect?.[target.id] ?? target.id)!;
    this.stack.push(shown);
    return this.viewOf(shown);
  }

  async back(child: FolderView, parent: FolderView): Promise<BackOutcome> {
    const node = this.top();
    if (this.viewOf(node).key !== child.key) throw new Error('simulação: filho não é a pasta exibida');
    if (this.behavior.failBack?.includes(node.id)) throw new Error(`falha ao voltar de ${node.name}`);
    this.stack.pop();
    this.log.push(`back:${node.id}`);
    if (this.viewOf(this.top()).key !== parent.key) throw new Error('simulação: voltou para outra pasta');
    const contentChanged = this.behavior.changeOnBack?.[node.id];
    return contentChanged ? { contentChanged } : {};
  }

  opened(): string[] {
    return this.log.filter((l) => l.startsWith('open:')).map((l) => l.slice(5));
  }
}
