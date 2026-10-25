/** Workerd's fetch already owns the response's content-coding semantics. */
export function fetchedResponse(response: Response, _method: string): Response {
  return response;
}
