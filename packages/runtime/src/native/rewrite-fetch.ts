// Node 24's Undici fetch decodes these codings, retaining their original HTTP headers. Unknown
// codings leave the entire representation encoded, including a chain containing an unknown one.
const DECODED_CODINGS = new Set(['br', 'deflate', 'gzip', 'x-gzip', 'zstd']);

/** Stream uploads through Node fetch and describe the decoded response bytes it returns. */
export async function fetchRewrite(target: URL, init: RequestInit): Promise<Response> {
  const nativeInit = { ...init, duplex: 'half' };
  const response = await fetch(target, nativeInit);
  const coding = response.headers.get('content-encoding');
  if (
    response.body === null ||
    coding
      ?.toLowerCase()
      .split(',')
      .every((item) => DECODED_CODINGS.has(item.trim())) !== true
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
