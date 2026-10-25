import type { InvokeInput } from '../invocation.ts';
import { createNodeBridge, NodeBridgeError } from './bridge.ts';

export { changesSomething } from '../invocation.ts';
export type { FailureAnswer, InvokeInput, Run } from '../invocation.ts';

// A build can resolve the runtime's node-bridge import to this module. Importing it performs no
// I/O and patches no globals. The host must still supply native bootstrap, paths and resources.
const HTTP_UNAVAILABLE = 503;
const HTTP_GATEWAY_TIMEOUT = 504;
const bridge = createNodeBridge();

export async function invokeNodeHandler(input: InvokeInput): Promise<Response> {
  try {
    return await bridge.invokeNodeHandler(input);
  } catch (error) {
    // The shared Function entry treats unexpected failures as 500. Expected native admission and
    // deadline failures have their own status, composed before that catch sees them.
    if (!(error instanceof NodeBridgeError)) throw error;
    const timeout = error.code === 'headers-timeout';
    return new Response(timeout ? 'Gateway Timeout' : 'Service Unavailable', {
      status: timeout ? HTTP_GATEWAY_TIMEOUT : HTTP_UNAVAILABLE,
      headers: {
        'cache-control': 'private, no-store',
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }
}

export function closeNodeBridge(timeoutMs?: number): Promise<boolean> {
  return bridge.close(timeoutMs);
}
