/** Drain both runtimes even if one cleanup fails; an ordinary stop still succeeds. */
export async function closeDevResources(
  disposeLocal: () => Promise<void>,
  closeApp: () => Promise<void>,
): Promise<void> {
  const actions = [disposeLocal, closeApp];
  const results = await Promise.allSettled(
    actions.map(async (action) => {
      await action();
    }),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      // Provider or application cleanup errors may contain secrets; report only the component.
      const component = index === 0 ? 'local resources' : 'Next.js';
      console.warn(`upwind: failed to close ${component}`);
    }
  }
}
