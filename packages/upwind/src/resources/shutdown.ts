import type { LocalAi } from './local-ai.ts';

/** A failed auxiliary session must not prevent recovery of healthy local storage. */
export async function discardAi(ai: LocalAi): Promise<void> {
  try {
    await ai.dispose();
  } catch {
    console.warn(
      'upwind: could not finish remote AI cleanup; retrying local storage without AI bindings',
    );
  }
}

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
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      const reason: unknown = result.reason;
      errors.push(reason);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Local resource cleanup failed');
}
