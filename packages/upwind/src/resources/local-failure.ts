/** workerd prefixes module evaluation failures with the owner service that failed to load. */
export function failedOwnerNames(error: unknown, names: readonly string[]): ReadonlySet<string> {
  const reason = error instanceof Error ? error.message : String(error);
  return new Set(names.filter((name) => reason.includes(`core:user:upwind-object-${name}:`)));
}
