import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesktop } from './build-desktop.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await buildDesktop();

// Terminais derivados do VS Code podem herdar esta variável, que faria o Electron rodar como Node, sem janela.
const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
const electron = createRequire(import.meta.url)('electron');
const child = spawn(electron, ['.'], { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
