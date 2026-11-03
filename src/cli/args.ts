import { sanitizeUrl } from '../safety/scope-validator.js';

/**
 * URL inicial da instância AIR, informada pelo usuário via `--url <url>`, `--url=<url>`
 * ou AIR_ORGANIZER_URL (o argumento tem precedência). Nenhuma instância é fixa no código.
 * A URL é validada (HTTPS, sem credenciais) e registrada sem query string nem fragmento.
 */
export function resolveInstanceUrl(argv: readonly string[], env: Record<string, string | undefined>): URL | undefined {
  let raw: string | undefined;
  for (const [i, arg] of argv.entries()) {
    if (arg === '--url') {
      raw = argv[i + 1];
      if (raw === undefined || raw.startsWith('--')) throw new Error('Informe a URL após --url.');
    } else if (arg.startsWith('--url=')) {
      raw = arg.slice('--url='.length);
    }
  }
  raw = (raw ?? env.AIR_ORGANIZER_URL)?.trim();
  return raw ? sanitizeUrl(raw) : undefined;
}
