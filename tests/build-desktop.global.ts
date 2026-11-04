/** Compila o aplicativo uma única vez, antes da suíte: os testes do desktop rodam em paralelo. */
export default async function setup(): Promise<void> {
  // @ts-expect-error script .mjs, sem tipos
  const { buildDesktop } = (await import('../scripts/build-desktop.mjs')) as { buildDesktop: () => Promise<void> };
  await buildDesktop();
}
