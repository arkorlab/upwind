import type { DeploymentBundle } from '@stayingupwind/core/bundle';

import { functionWorker } from './function-worker.ts';
import { workerApp } from './worker-function.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const HTTP_OK = 200;

/** One actual request, through the same module layout the built Function is uploaded with. */
export async function externalOutputHolds(
  bundle: DeploymentBundle,
  _dependencies: unknown,
  out: string,
): Promise<string[]> {
  if (bundle.prerenders.some((entry) => entry.pathname === '/')) {
    return ['the external-output page was prerendered instead of remaining dynamic'];
  }
  const spec = workerApp(bundle);
  if (spec.modules.every(({ name }) => !name.endsWith('_client-reference-manifest.json'))) {
    return ['the external-output Function carries no client-reference manifest'];
  }
  // Most matrix fixtures need no native runtime: load it only for the ones that make a request.
  const { Miniflare } = await import('miniflare');
  const runtime = new Miniflare({ workers: [await functionWorker('external-output', spec, out)] });
  try {
    const response = await runtime.dispatchFetch('http://external-output.test/', {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.text();
    const problems: string[] = [];
    if (response.status !== HTTP_OK)
      problems.push(`external-output HTTP status: ${String(response.status)}`);
    if (!body.includes('external-output-server'))
      problems.push('external-output server marker absent');
    if (!body.includes('external-output-client'))
      problems.push('external-output client marker absent');
    const api = await runtime.dispatchFetch('http://external-output.test/api/pages-api', {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (api.status !== HTTP_OK)
      problems.push(`external-output Pages API HTTP status: ${String(api.status)}`);
    if ((await api.text()) !== 'external-output-pages-api')
      problems.push('external-output Pages API body differs');
    return problems;
  } finally {
    await runtime.dispose();
  }
}
