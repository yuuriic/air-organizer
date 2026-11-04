import { describe, expect, it } from 'vitest';
import { DedicatedChromeSession, classifyLaunchError, type ChromeContext, type ChromeStatus } from '../../src/app/connection.js';
import { isTrustedSender } from '../../src/desktop/ipc-contract.js';
import { SafetyViolation } from '../../src/safety/scope-validator.js';

function fakeContext() {
  let closeListener = () => {};
  let closes = 0;
  const context: ChromeContext = {
    close: async () => {
      closes++;
      closeListener();
    },
    on: (_event, listener) => {
      closeListener = listener;
    },
  };
  return { context, closedExternally: () => closeListener(), closes: () => closes };
}

describe('sessão do Chrome dedicado', () => {
  it('chamadas simultâneas e repetidas abrem uma única sessão', async () => {
    const fake = fakeContext();
    let launches = 0;
    const session = new DedicatedChromeSession(async () => (launches++, fake.context));
    const [a, b] = await Promise.all([session.open(), session.open()]);
    await session.open();
    expect(launches).toBe(1);
    expect([a.state, b.state, session.status.state]).toEqual(['open', 'open', 'open']);
  });

  it('informa cada transição e fecha uma vez', async () => {
    const fake = fakeContext();
    const seen: ChromeStatus['state'][] = [];
    const session = new DedicatedChromeSession(async () => fake.context, (s) => seen.push(s.state));
    await session.open();
    await Promise.all([session.close(), session.close()]);
    expect(seen).toEqual(['opening', 'open', 'closing', 'closed']);
    expect(fake.closes()).toBe(1);
  });

  it('Chrome encerrado por fora volta a "fechado" e pode ser reaberto', async () => {
    const fake = fakeContext();
    let launches = 0;
    const session = new DedicatedChromeSession(async () => (launches++, fake.context));
    await session.open();
    fake.closedExternally();
    expect(session.status).toEqual({ state: 'closed' });
    await session.open();
    expect(launches).toBe(2);
  });

  it('fechar durante a abertura espera a abertura e fecha', async () => {
    const fake = fakeContext();
    let finish: (c: ChromeContext) => void = () => {};
    const session = new DedicatedChromeSession<ChromeContext>(() => new Promise((resolve) => (finish = resolve)));
    const open = session.open();
    const close = session.close();
    finish(fake.context);
    await open;
    expect(await close).toEqual({ state: 'closed' });
    expect(fake.closes()).toBe(1);
  });

  it('falha ao abrir: motivo seguro, sem o texto do erro, e permite tentar de novo', async () => {
    const session = new DedicatedChromeSession(async () => {
      throw new Error('falhou em C:\\Users\\fulano\\perfil');
    });
    const status = await session.open();
    expect(status).toEqual({ state: 'closed', failure: 'launch-failed' });
    expect(JSON.stringify(status)).not.toContain('fulano');
  });

  it.each([
    [new SafetyViolation('perfil pessoal'), 'profile-not-allowed'],
    [new Error("Chromium distribution 'chrome' is not found at C:\\x"), 'chrome-not-found'],
    [new Error('Failed to create a ProcessSingleton for your profile directory'), 'profile-in-use'],
    [new Error('Target page, context or browser has been closed'), 'profile-in-use'],
    [new Error('qualquer outra'), 'launch-failed'],
  ])('classifica o erro de abertura (%#)', (error, expected) => {
    expect(classifyLaunchError(error)).toBe(expected);
  });
});

describe('origem das chamadas ao processo principal', () => {
  const APP = 'file:///C:/app/ui/index.html';

  it('só aceita a página principal do aplicativo', () => {
    expect(isTrustedSender(APP, true, APP)).toBe(true);
    expect(isTrustedSender(APP, false, APP)).toBe(false);
    expect(isTrustedSender('https://externo.test/', true, APP)).toBe(false);
    expect(isTrustedSender('file:///C:/outro/index.html', true, APP)).toBe(false);
    expect(isTrustedSender(undefined, true, APP)).toBe(false);
  });
});
