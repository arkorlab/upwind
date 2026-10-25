# Native Node transport

The native target invokes Next.js's Node entrypoints using real `IncomingMessage` and
`ServerResponse` objects. The transport uses only Node built-ins; it opens no socket and changes
no global when imported. The adapter selects it while building a Node deployment, so Workers
bundles carry their existing transport alone.

The public source API is available for a host's bundler:

```ts
import { createNodeBridge, TaskGroup } from '@stayingupwind/runtime/native';

const tasks = new TaskGroup(console.error);
const bridge = createNodeBridge({ onError: console.error });
try {
  const response = await bridge.invokeNodeHandler({
    handler: async (request, response) => {
      response.end(`Handled ${request.url}`);
    },
    request: new Request('https://app.example/hello'),
    requestMeta: {},
    waitUntil: tasks.waitUntil,
  });
  console.log(await response.text());
} finally {
  await bridge.close(30_000);
  await tasks.drain(30_000);
}
```

`createNodeBridge` accepts `maxInFlight` (default `256`), `headersTimeoutMs` (default `30_000`),
and `onError`. A call returns once response headers arrive, while both body directions continue
streaming with backpressure. The private listener starts lazily on an OS-assigned loopback port.
Its own bounded keep-alive Agent reuses connections without changing application HTTP clients.
Request metadata remains in memory, including capture callbacks and the caller's `run` function
that restores its async context. A one-use token associates each exchange with that metadata.

The handler sees the public Host, input headers and rewritten URL. Redirects remain redirects,
compressed bytes retain their representation headers, and separate Set-Cookie fields survive.
HEAD, 204, 205 and 304 responses expose no body. Connection-scoped response fields are removed.
A failure before headers invokes the supplied error page or answers a private, non-cacheable 500;
failed representation metadata is cleared first. A failure after headers breaks the stream.
Upgrades, CONNECT, trailers and early hints have no representation in this interface.

`NodeBridgeError.code` distinguishes `capacity`, `headers-timeout` and `closing` so the native
host can report admission failures as 503 and header deadlines as 504. Capacity counts accepted
handlers until their work and transport have both finished, even after their response ends. It
rejects excess work rather than growing a pending queue. The header deadline does not limit the
lifetime of an SSE or other streaming body.

Mutations are registered with the supplied `waitUntil` from the start; safe handlers are registered
after a normal response finish. A prematurely closed safe stream does not acquire that retention.
An AbortSignal cancels the transport and an incomplete request body remains incomplete. Accepted
application work can continue after a disconnect; the bridge does not promise durable execution.
Callers must consume or cancel response bodies.

`close(timeoutMs)` stops admission, drains accepted handlers and sockets, and destroys the bridge's
Agent. Its default deadline is ten seconds; a host can supply its shutdown budget. It is idempotent
and returns `false` when its deadline interrupts the drain. `TaskGroup.drain(timeoutMs)` includes
work registered by settling tasks and contains rejecting error reporters. The host must keep its
application dependencies alive through both drains; neither facility is a persistent job queue.
