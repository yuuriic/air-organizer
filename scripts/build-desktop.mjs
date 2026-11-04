import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'desktop');
const src = (file) => path.join(root, 'src', 'desktop', file);

/** Gera dist/desktop. A janela e o preload não recebem módulos do backend. */
export async function buildDesktop() {
  await rm(out, { recursive: true, force: true });
  const common = { bundle: true, logLevel: 'warning', target: 'es2022' };
  await build({ ...common, entryPoints: [src('main.ts')], outfile: path.join(out, 'main.mjs'), platform: 'node', format: 'esm', packages: 'external' });
  await build({ ...common, entryPoints: [src('preload.ts')], outfile: path.join(out, 'preload.cjs'), platform: 'node', format: 'cjs', external: ['electron'] });
  await build({ ...common, entryPoints: [src('ui/app.ts')], outfile: path.join(out, 'ui', 'app.js'), platform: 'browser', format: 'iife' });
  await cp(src('ui/index.html'), path.join(out, 'ui', 'index.html'));
  await cp(src('ui/styles.css'), path.join(out, 'ui', 'styles.css'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildDesktop();
