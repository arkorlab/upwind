import type { NextRequest } from 'next/server';

interface RequestContext {
  get: () => { headers: Record<string, string>; url: string } | undefined;
}

/** What Vercel's runtime exposes to libraries, and what `@vercel/analytics/server` reads. */
function requestContext(): { headers: Record<string, string>; url: string } | undefined {
  const provider = (globalThis as Record<symbol, unknown>)[
    Symbol.for('@vercel/request-context')
  ] as RequestContext | undefined;
  return provider?.get();
}

/** Answers with what it was asked: method, the headers named on the query, and the body. */
async function echo(request: NextRequest): Promise<Response> {
  const named = request.nextUrl.searchParams.getAll('header');
  const headers: Record<string, string | null> = {};
  const context = requestContext();
  const contextHeaders: Record<string, string | null> = {};
  for (const name of named) {
    headers[name] = request.headers.get(name);
    contextHeaders[name] = context?.headers[name] ?? null;
  }
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  return Response.json(
    {
      method: request.method,
      path: request.nextUrl.pathname,
      headers,
      body,
      instrumented: globalThis.fixtureInstrumented ?? 0,
      context: context === undefined ? null : { url: context.url, headers: contextHeaders },
    },
    { headers: { 'set-cookie': 'echoed=1; Path=/', 'x-echo': '1' } },
  );
}

export const GET = echo;
export const POST = echo;
export const PUT = echo;
