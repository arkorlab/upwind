/** Release a constructed server if preparation or the remaining startup work fails. */
export async function completeNextStartup<Result>(
  close: () => Promise<void>,
  start: () => Promise<Result>,
): Promise<Result> {
  try {
    return await start();
  } catch (error) {
    try {
      await close();
    } catch {
      // Application cleanup can contain secrets; report the component and preserve startup's error.
      console.warn('upwind: failed to close partially started Next.js');
    }
    throw error;
  }
}
