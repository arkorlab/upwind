/** Native readiness errors differ from failures returned by individual storage probes. */
export function runtimeStartupFailure(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && 'code' in error && error.code === 'ERR_RUNTIME_FAILURE';
}

function logMessage(line: string): string {
  try {
    const value: unknown = JSON.parse(line);
    if (
      typeof value === 'object' &&
      value !== null &&
      'message' in value &&
      typeof value.message === 'string'
    )
      return value.message;
  } catch {
    // Older workerd logs use the same service prefix without a JSON envelope.
  }
  return line;
}

/** Read the actual workerd service prefix, before any customer exception text. */
export function failedOwnerNames(error: unknown, names: readonly string[]): ReadonlySet<string> {
  const reason = error instanceof Error ? error.message : String(error);
  const registered = new Set(names);
  const failed = new Set<string>();
  for (const line of reason.split('\n')) {
    const match = /^service core:user:upwind-object-([A-Za-z_]\w*):/u.exec(logMessage(line));
    const name = match?.[1];
    if (name !== undefined && registered.has(name)) failed.add(name);
  }
  return failed;
}
