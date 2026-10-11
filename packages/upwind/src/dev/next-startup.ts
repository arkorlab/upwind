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
      console.warn('upwind: failed to close partially started Next.js');
    }
    throw error;
  }
}
