import { fetchedResponse } from './node-fetch-response.ts';

/** Only Container rewrites use Node's decoded fetch representation and streamed upload mode. */
export async function fetchRewrite(target: URL, init: RequestInit): Promise<Response> {
  const nativeInit: RequestInit & { duplex?: 'half' } = { ...init };
  if (init.body !== undefined && init.body !== null) nativeInit.duplex = 'half';
  return fetchedResponse(await fetch(target, nativeInit), init.method ?? 'GET');
}
