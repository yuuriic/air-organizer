import { SafetyViolation } from '../safety/scope-validator.js';

/** Motivo de falha seguro para a interface: sem caminhos nem o texto do erro original. */
export type ChromeFailure = 'profile-in-use' | 'chrome-not-found' | 'profile-not-allowed' | 'launch-failed';

export type ChromeStatus = { state: 'closed' | 'opening' | 'open' | 'closing'; failure?: ChromeFailure };

/** O que a sessão usa do contexto do Playwright. */
export type ChromeContext = { close(): Promise<void>; on(event: 'close', listener: () => void): unknown };

export function classifyLaunchError(error: unknown): ChromeFailure {
  if (error instanceof SafetyViolation) return 'profile-not-allowed';
  const text = error instanceof Error ? error.message : String(error);
  if (/distribution '?chrome'? is not found|chrome.*not found|executable doesn't exist/i.test(text)) return 'chrome-not-found';
  if (/ProcessSingleton|SingletonLock|already in use|in use by another|existing browser session|Target page, context or browser has been closed/i.test(text)) return 'profile-in-use';
  return 'launch-failed';
}

/**
 * Uma única sessão do Chrome dedicado por processo. O login é manual no próprio Chrome; esta classe
 * não lê cookies, tokens nem páginas. Chamadas repetidas de `open` não abrem uma segunda sessão.
 */
export class DedicatedChromeSession<C extends ChromeContext = ChromeContext> {
  private activeContext: C | undefined;
  private current: ChromeStatus = { state: 'closed' };
  private opening: Promise<ChromeStatus> | undefined;
  private closing: Promise<ChromeStatus> | undefined;

  constructor(
    private readonly launch: () => Promise<C>,
    private readonly onChange: (status: ChromeStatus) => void = () => {},
  ) {}

  get status(): ChromeStatus {
    return this.current;
  }

  /** Contexto aberto, quando houver. */
  get context(): C | undefined {
    return this.activeContext;
  }

  open(): Promise<ChromeStatus> {
    if (this.opening) return this.opening;
    if (this.closing) return this.closing;
    if (this.activeContext) return Promise.resolve(this.current);
    this.set({ state: 'opening' });
    this.opening = this.launch()
      .then((context) => {
        this.activeContext = context;
        context.on('close', () => {
          if (this.activeContext !== context) return;
          this.activeContext = undefined;
          this.set({ state: 'closed' });
        });
        return this.set({ state: 'open' });
      })
      .catch((error: unknown) => this.set({ state: 'closed', failure: classifyLaunchError(error) }))
      .finally(() => {
        this.opening = undefined;
      });
    return this.opening;
  }

  close(): Promise<ChromeStatus> {
    if (this.closing) return this.closing;
    if (this.opening) return this.opening.then(() => this.close());
    const context = this.activeContext;
    if (!context) return Promise.resolve(this.current);
    this.activeContext = undefined;
    this.set({ state: 'closing' });
    this.closing = context
      .close()
      .catch(() => {}) // o Chrome pode já ter sido encerrado pelo usuário
      .then(() => this.set({ state: 'closed' }))
      .finally(() => {
        this.closing = undefined;
      });
    return this.closing;
  }

  private set(status: ChromeStatus): ChromeStatus {
    this.current = status;
    this.onChange(status);
    return status;
  }
}
