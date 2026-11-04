import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchDedicatedChrome } from '../air/session.js';
import { startDesktop } from './shell.js';

startDesktop({ launch: launchDedicatedChrome, appDir: path.dirname(fileURLToPath(import.meta.url)) });
