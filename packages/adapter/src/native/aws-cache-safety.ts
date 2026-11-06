/** Compile the AWS cache failure policy without changing Workers or standalone Node execution. */
export function strictAwsCacheSource(source: string, kind: 'pulls' | 'function'): string {
  const needle =
    kind === 'pulls'
      ? 'await settledWithin(caughtUp, SCOPE_CATCH_UP_MS);'
      : "status: HTTP_INTERNAL_ERROR,\n      headers: { 'content-type': 'text/plain; charset=utf-8' },";
  if (source.split(needle).length !== 2)
    throw new Error(
      `AWS native cache safety no longer matches runtime ${kind}; update the compiler before building`,
    );
  if (kind === 'pulls') {
    const recency =
      'scope.revision <= runtime.tags.revision ||\n    nowMs() - invalidatedAt > RECENT_INVALIDATION_MS';
    if (source.split(recency).length !== 2)
      throw new Error('AWS native cache safety no longer matches the runtime recency policy');
    // Shared AWS heads stay immutable: elapsed time cannot prove a task's memo is current.
    return source
      .replace(recency, 'scope.revision <= runtime.tags.revision')
      .replace(
        needle,
        `${needle}\n  if (runtime.tags.revision < scope.revision) {\n    throw Object.assign(new Error('AWS cache could not confirm the required tag revision'), { status: 503 });\n  }`,
      );
  }
  return source.replace(
    needle,
    "status: error instanceof Error && Reflect.get(error, 'status') === 503 ? 503 : HTTP_INTERNAL_ERROR,\n      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' },",
  );
}
