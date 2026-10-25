/** Workers preserve the upstream encoding; the native build selects its fetch adapter instead. */
export function fetchRewrite(target: URL, init: RequestInit): Promise<Response> {
  return fetch(target, init);
}
