import type { LocalAi } from './local-ai.ts';

/** Start remote cleanup while local shutdown still has its own bounded window. */
export async function disposeLocalResources(
  stopStorage: () => Promise<void>,
  ai: Pick<LocalAi, 'dispose'> | undefined,
): Promise<void> {
  const disposeAi = async (): Promise<void> => {
    await ai?.dispose();
  };
  const disposeStorage = async (): Promise<void> => {
    await stopStorage();
  };
  const results = await Promise.allSettled([disposeAi(), disposeStorage()]);
  for (const result of results) {
    if (result.status === 'rejected') {
      const reason: unknown = result.reason;
      throw reason;
    }
  }
}
