import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { SafetyViolation } from '../safety/scope-validator.js';

/**
 * Perfil de navegador DEDICADO à automação, fora do repositório.
 * O login é feito manualmente pelo usuário nesse perfil; nenhum cookie ou token
 * é lido, copiado ou exportado pela ferramenta.
 */
export function dedicatedProfileDir(): string {
  const configured = process.env.AIR_ORGANIZER_PROFILE_DIR?.trim();
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share');
  const dir = path.resolve(configured || path.join(base, 'air-organizer', 'chrome-profile'));
  assertNotPersonalProfile(dir);
  return dir;
}

/** Recusa diretórios de perfil padrão do Chrome/Edge (perfis pessoais). */
export function assertNotPersonalProfile(dir: string): void {
  const normalized = path.resolve(dir).replace(/\\/g, '/').toLowerCase();
  const personal = ['/google/chrome/user data', '/microsoft/edge/user data', '/.config/google-chrome', '/library/application support/google/chrome'];
  if (personal.some((p) => normalized.includes(p))) {
    throw new SafetyViolation('O perfil pessoal do navegador não pode ser usado. Configure um diretório dedicado.');
  }
  if (normalized.startsWith(process.cwd().replace(/\\/g, '/').toLowerCase() + '/')) {
    throw new SafetyViolation('O perfil do navegador não pode ficar dentro do repositório.');
  }
}

/**
 * Abre um Chrome separado com perfil dedicado. Não se conecta a janelas já abertas
 * pelo usuário nem as encerra. Downloads são recusados.
 */
export async function launchDedicatedChrome(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(dedicatedProfileDir(), {
    channel: 'chrome',
    headless: false,
    viewport: null,
    acceptDownloads: false,
  });
}

export function httpPages(context: BrowserContext): Page[] {
  return context.pages().filter((p) => /^https?:/i.test(p.url()));
}
