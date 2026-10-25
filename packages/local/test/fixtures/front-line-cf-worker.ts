import { frontLineCf } from '../../src/front-line-cf.ts';

type CfRequest = Request & { readonly cf?: Readonly<Record<string, unknown>> };
/** The native incoming request, before and after the local front line reconstructs it. */
export function receive(request: CfRequest): Response {
  type CfInit = RequestInit & { readonly cf: Readonly<Record<string, unknown>> };

  const incoming = request.cf;
  const before = JSON.stringify(incoming);
  let legacyError: string | null = null;
  let legacyCf: Readonly<Record<string, unknown>> | null = null;
  try {
    const legacy = new Request(request, {
      cf: { ...incoming, clientAcceptEncoding: 'identity' },
    } as CfInit) as CfRequest;
    legacyCf = legacy.cf ?? null;
  } catch (error) {
    legacyError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  const handed = new Request(request, {
    cf: frontLineCf(incoming, 'identity'),
  } as CfInit) as CfRequest;
  return Response.json({
    incoming,
    legacyError,
    legacyCf,
    handed: handed.cf,
    untouched: JSON.stringify(incoming) === before,
  });
}
