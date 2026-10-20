import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import ts from 'typescript';

const REQUEST_MS = 10_000;
const CLEANUP_MS = 5000;
const STREAM_CANCEL_MS = 2000;
const STREAM_OBSERVATION_INTERVAL_MS = 25;
const HTTP_OK = 200;
const OBSERVER_BINDING = 'OBSERVER';
const UPSTREAM_WORKER = 'node-handler-upstream';
const HANDLER_ORIGIN = 'https://handler.test';
const STATE_URL = `${HANDLER_ORIGIN}/state`;
const UPSTREAM_STATE_URL = `${HANDLER_ORIGIN}/upstream-state`;
const STREAM_KIND = 'stream-cancellation';
const DELAYED_FINISH_KIND = 'delayed-finish';
const UNCONDITIONAL_MODE = 'unconditional-retention';
const GUARDED_MODE = 'previous-method-guard';
const TASK_SOURCE_IMPORT = "'./tasks.ts'";
const TASK_COMPILED_IMPORT = "'./tasks.mjs'";
const ROOT = path.resolve(import.meta.dirname, '../../..');
const HOLD = '  retainHandler(dispatch.input, res, handled);';
const GUARDED_HOLD = [
  '  if (changesSomething(dispatch.input.request.method)) {',
  '    dispatch.input.waitUntil(handled);',
  '  }',
].join('\n');
const UNCONDITIONAL_HOLD = '  dispatch.input.waitUntil(handled);';
const WORKER = `
import { invokeNodeHandler } from './node-bridge.mjs';
let held = 0;
let completed = false;
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/state') {
      return Response.json({ held, completed });
    }
    if (new URL(request.url).pathname === '/upstream-state') {
      return env.EVENTS.fetch('https://upstream.test/state');
    }
    return invokeNodeHandler({
      request,
      requestMeta: {},
      waitUntil(pending) { held++; ctx.waitUntil(pending); },
      async handler(_request, response) {
        if (new URL(request.url).pathname === '/stream') {
          const upstream = await env.EVENTS.fetch('https://upstream.test/events');
          const reader = upstream.body.getReader();
          const close = () => { reader.cancel().catch(() => {}); };
          response.once('close', close);
          response.setHeader('content-type', 'text/event-stream');
          response.flushHeaders();
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              response.write(chunk.value);
            }
          } finally {
            response.off('close', close);
            response.end();
          }
          return;
        }
        if (new URL(request.url).pathname === '/delayed-finish') {
          response.setHeader('content-type', 'text/plain');
          response.flushHeaders();
          response.write(new TextEncoder().encode('first'));
          const finish = await env.OBSERVER.fetch('https://observer.test/finish');
          await finish.text();
          response.end('last');
        } else {
          response.end('response before hook completion');
        }
        const release = await env.OBSERVER.fetch('https://observer.test/hold');
        await release.text();
        completed = true;
        const written = await env.OBSERVER.fetch('https://observer.test/completed');
        await written.text();
      },
    });
  },
};
`;

const UPSTREAM = String.raw`
let active = 0;
export default {
  fetch(request) {
    if (new URL(request.url).pathname === '/state') return Response.json({ active });
    active++;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(': open\n\n')); },
      cancel() { active--; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  },
};
`;

interface Lane {
  readonly kind: 'finite-response' | typeof STREAM_KIND | typeof DELAYED_FINISH_KIND;
  readonly method: 'GET' | 'POST';
  readonly mode: 'retained' | typeof GUARDED_MODE | 'unconditional-retention';
  responseBeforeCompletion: boolean;
  hookStarted: boolean;
  held: number | undefined;
  heldWhileOpen?: number;
  completedAfterRelease: boolean;
  egressAttempts: number;
  upstreamCancelledBeforeDeadline?: boolean;
  responseCancelCompleted?: boolean;
  activeBeforeCancel?: number;
  cancellationOutcome?: 'released' | 'deadline';
  cancellationDeadlineStage?: 'reader-cancel' | 'upstream-cancel';
  activeAfterCancel?: number;
  stage: string;
  failureStage?: string;
}

const PATHNAMES: Readonly<Record<Lane['kind'], string>> = {
  'finite-response': '/respond',
  [STREAM_KIND]: '/stream',
  [DELAYED_FINISH_KIND]: '/delayed-finish',
};

/** Bound worker startup, response reads, observation and disposal independently. */
async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const refused = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Timed out'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([pending, refused]);
  } finally {
    if (abort !== undefined) signal.removeEventListener('abort', abort);
  }
}

function compiled(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
  }).outputText;
}

interface State {
  readonly held: number;
  readonly completed: boolean;
}

async function observeCancellation(
  runtime: Miniflare,
  response: Awaited<ReturnType<Miniflare['dispatchFetch']>>,
  lane: Lane,
  signal: AbortSignal,
): Promise<void> {
  const { body } = response;
  assert.ok(body !== null);
  const reader = body.getReader();
  const first = await bounded(reader.read(), signal);
  assert.ok(first.value instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(first.value), ': open\n\n');
  lane.responseBeforeCompletion = true;
  const observation = await bounded(runtime.dispatchFetch(STATE_URL), signal);
  const state = (await bounded(observation.json(), signal)) as State;
  lane.held = state.held;
  assert.equal(state.held, lane.mode === UNCONDITIONAL_MODE ? 1 : 0);
  const upstream = await bounded(runtime.dispatchFetch(UPSTREAM_STATE_URL), signal);
  const before = (await bounded(upstream.json(), signal)) as { readonly active: number };
  lane.activeBeforeCancel = before.active;
  assert.equal(before.active, 1);
  const cancellationDeadline = AbortSignal.timeout(STREAM_CANCEL_MS);
  lane.upstreamCancelledBeforeDeadline = false;
  lane.responseCancelCompleted = false;
  lane.stage = 'stream-reader-cancel';
  try {
    await bounded(reader.cancel(), cancellationDeadline);
    lane.responseCancelCompleted = true;
    lane.stage = 'stream-upstream-cancel';
    for (;;) {
      const afterCancellation = await bounded(
        runtime.dispatchFetch(UPSTREAM_STATE_URL),
        cancellationDeadline,
      );
      const current = (await bounded(afterCancellation.json(), cancellationDeadline)) as {
        readonly active: number;
      };
      lane.activeAfterCancel = current.active;
      if (current.active === 0) break;
      await bounded(
        new Promise<void>((resolve) => {
          setTimeout(resolve, STREAM_OBSERVATION_INTERVAL_MS);
        }),
        cancellationDeadline,
      );
    }
    lane.upstreamCancelledBeforeDeadline = true;
    lane.cancellationOutcome = 'released';
  } catch (error) {
    if (
      lane.mode !== UNCONDITIONAL_MODE ||
      !cancellationDeadline.aborted ||
      error !== cancellationDeadline.reason
    )
      throw error;
    lane.cancellationOutcome = 'deadline';
    lane.cancellationDeadlineStage = lane.responseCancelCompleted
      ? 'upstream-cancel'
      : 'reader-cancel';
  }
  if (lane.mode !== UNCONDITIONAL_MODE) assert.ok(lane.upstreamCancelledBeforeDeadline);
  lane.stage = 'completed';
}

/** Run the actual bridge in workerd; the observer is an in-process service, never the network. */
async function exercise(bridge: string, tasks: string, lane: Lane): Promise<void> {
  const release = Promise.withResolvers<undefined>();
  const finish = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  const completed = Promise.withResolvers<undefined>();
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      log: new Log(LogLevel.NONE),
      workers: [
        {
          name: 'node-handler-lifetime',
          modulesRoot: '/lifetime',
          modules: [
            { type: 'ESModule', path: '/lifetime/worker.mjs', contents: WORKER },
            { type: 'ESModule', path: '/lifetime/node-bridge.mjs', contents: bridge },
            { type: 'ESModule', path: '/lifetime/tasks.mjs', contents: tasks },
          ],
          // The Function pins these in packages/adapter/src/function.ts.
          compatibilityDate: '2026-09-15',
          compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
          serviceBindings: {
            EVENTS: UPSTREAM_WORKER,
            [OBSERVER_BINDING]: async (request) => {
              const pathname = new URL(request.url).pathname;
              switch (pathname) {
                case '/hold': {
                  lane.hookStarted = true;
                  started.resolve(undefined);
                  await release.promise;

                  break;
                }
                case '/finish': {
                  await finish.promise;

                  break;
                }
                default: {
                  assert.equal(pathname, '/completed');
                  lane.completedAfterRelease = true;
                  completed.resolve(undefined);
                }
              }
              return new Response('observed');
            },
          },
          outboundService: () => {
            lane.egressAttempts += 1;
            throw new Error('Handler lifetime proof attempted outbound network');
          },
        },
        {
          name: UPSTREAM_WORKER,
          modulesRoot: '/upstream',
          modules: [{ type: 'ESModule', path: '/upstream/worker.mjs', contents: UPSTREAM }],
          compatibilityDate: '2026-09-15',
          compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
          outboundService: () => {
            lane.egressAttempts += 1;
            throw new Error('Upstream lifetime proof attempted outbound network');
          },
        },
      ],
    }),
  );
  const signal = AbortSignal.timeout(REQUEST_MS);
  try {
    lane.stage = 'worker-start';
    await bounded(runtime.ready, signal);
    lane.stage = 'response-headers';
    const pathname = PATHNAMES[lane.kind];
    const response = await bounded(
      runtime.dispatchFetch(`${HANDLER_ORIGIN}${pathname}`, { method: lane.method }),
      signal,
    );
    assert.equal(response.status, HTTP_OK);
    lane.stage = 'response-body';
    if (lane.kind === STREAM_KIND) {
      await observeCancellation(runtime, response, lane, signal);
      return;
    }
    if (lane.kind === DELAYED_FINISH_KIND) {
      const { body } = response;
      assert.ok(body !== null);
      const reader = body.getReader();
      lane.stage = 'delayed-held-open';
      const observation = await bounded(runtime.dispatchFetch(STATE_URL), signal);
      const state = (await bounded(observation.json(), signal)) as State;
      lane.heldWhileOpen = state.held;
      assert.equal(state.held, lane.mode === UNCONDITIONAL_MODE ? 1 : 0);
      lane.stage = 'delayed-first-chunk';
      const first = await bounded(reader.read(), signal);
      assert.ok(first.value instanceof Uint8Array);
      assert.equal(new TextDecoder().decode(first.value), 'first');
      finish.resolve(undefined);
      let rest = '';
      for (;;) {
        const chunk = await bounded(reader.read(), signal);
        if (chunk.done) break;
        assert.ok(chunk.value instanceof Uint8Array);
        rest += new TextDecoder().decode(chunk.value);
      }
      assert.equal(rest, 'last');
    } else {
      assert.equal(await bounded(response.text(), signal), 'response before hook completion');
    }
    const expected = lane.mode === GUARDED_MODE && lane.method === 'GET' ? 0 : 1;
    // An unretained GET can end before even the observer receives its first call. Only retained
    // lanes must reach that call; requiring it from the former guard would wait for cancelled work.
    if (expected === 1) {
      lane.stage = 'hook-start';
      await bounded(started.promise, signal);
    }
    lane.stage = 'held-state';
    const observation = await bounded(runtime.dispatchFetch(STATE_URL), signal);
    const state = (await bounded(observation.json(), signal)) as State;
    assert.equal(state.completed, false, 'the hook finished before the response was read');
    lane.responseBeforeCompletion = true;
    lane.held = state.held;
    assert.equal(state.held, expected, 'the bridge did not retain the expected handler promise');
    release.resolve(undefined);
    // The control establishes the former missing lifetime registration. Miniflare need not cancel
    // its unheld work identically to a deployed Worker, so make no assertion that it is cancelled.
    if (expected === 1) {
      lane.stage = 'hook-completion';
      await bounded(completed.promise, signal);
    }
    lane.stage = 'completed';
  } catch (error) {
    lane.failureStage = lane.stage;
    throw error;
  } finally {
    finish.resolve(undefined);
    release.resolve(undefined);
    await bounded(runtime.dispose(), AbortSignal.timeout(CLEANUP_MS));
    assert.equal(lane.egressAttempts, 0);
  }
}

const source = await readFile(path.join(ROOT, 'packages/runtime/src/node-bridge.ts'), 'utf8');
assert.equal(source.split(HOLD).length, 2, 'the bridge lifetime boundary moved');
const previous = source.replace(HOLD, () => GUARDED_HOLD);
const unconditional = source.replace(HOLD, () => UNCONDITIONAL_HOLD);
const tasks = compiled(await readFile(path.join(ROOT, 'packages/runtime/src/tasks.ts'), 'utf8'));
const lanes: Lane[] = [];
const failures: {
  readonly kind: Lane['kind'];
  readonly mode: Lane['mode'];
  readonly detail: string;
}[] = [];
const proof = {
  status: 'running',
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  control: 'current bridge with the previous method-only guard restored',
  officialCase: 'not-run',
  lanes,
  failures,
  cancellationComparison: {
    baselineReleased: false,
    currentReleased: false,
    unconditionalReleased: false,
    reproducesRetentionRegression: false,
    status: 'inconclusive',
  },
};
const directory = process.env['UPWIND_MATRIX_PROOF_DIR'] ?? path.join(ROOT, '.node-handler-proof');
await mkdir(directory, { recursive: true });
async function collect(variant: string, lane: Lane): Promise<void> {
  lanes.push(lane);
  const bridge = compiled(variant).replace(TASK_SOURCE_IMPORT, () => TASK_COMPILED_IMPORT);
  try {
    await exercise(bridge, tasks, lane);
  } catch (error) {
    failures.push({
      kind: lane.kind,
      mode: lane.mode,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
try {
  for (const mode of [GUARDED_MODE, 'retained'] as const) {
    for (const method of ['GET', 'POST'] as const) {
      const lane: Lane = {
        kind: 'finite-response',
        mode,
        method,
        responseBeforeCompletion: false,
        hookStarted: false,
        held: undefined,
        completedAfterRelease: false,
        egressAttempts: 0,
        stage: 'created',
      };
      await collect(mode === 'retained' ? source : previous, lane);
    }
  }
  for (const mode of [GUARDED_MODE, UNCONDITIONAL_MODE, 'retained'] as const) {
    let variant = source;
    if (mode === GUARDED_MODE) variant = previous;
    if (mode === UNCONDITIONAL_MODE) variant = unconditional;
    const delayed: Lane = {
      kind: DELAYED_FINISH_KIND,
      mode,
      method: 'GET',
      responseBeforeCompletion: false,
      hookStarted: false,
      held: undefined,
      completedAfterRelease: false,
      egressAttempts: 0,
      stage: 'created',
    };
    await collect(variant, delayed);
  }
  for (const mode of [GUARDED_MODE, UNCONDITIONAL_MODE, 'retained'] as const) {
    let variant = source;
    if (mode === GUARDED_MODE) variant = previous;
    if (mode === UNCONDITIONAL_MODE) variant = unconditional;
    const lane: Lane = {
      kind: STREAM_KIND,
      mode,
      method: 'GET',
      responseBeforeCompletion: false,
      hookStarted: false,
      held: undefined,
      completedAfterRelease: false,
      egressAttempts: 0,
      stage: 'created',
    };
    await collect(variant, lane);
  }
  const baseline = lanes.find((lane) => lane.kind === STREAM_KIND && lane.mode === GUARDED_MODE);
  const current = lanes.find((lane) => lane.kind === STREAM_KIND && lane.mode === 'retained');
  const unconditionallyHeld = lanes.find(
    (lane) => lane.kind === STREAM_KIND && lane.mode === UNCONDITIONAL_MODE,
  );
  function completedControl(lane: Lane | undefined): boolean {
    return (
      lane?.stage === 'completed' &&
      failures.every((failure) => failure.kind !== lane.kind || failure.mode !== lane.mode)
    );
  }
  proof.cancellationComparison.baselineReleased =
    baseline?.upstreamCancelledBeforeDeadline === true;
  proof.cancellationComparison.currentReleased = current?.upstreamCancelledBeforeDeadline === true;
  proof.cancellationComparison.unconditionalReleased =
    unconditionallyHeld?.upstreamCancelledBeforeDeadline === true;
  proof.cancellationComparison.reproducesRetentionRegression =
    completedControl(baseline) &&
    completedControl(current) &&
    completedControl(unconditionallyHeld) &&
    proof.cancellationComparison.baselineReleased &&
    proof.cancellationComparison.currentReleased &&
    unconditionallyHeld?.cancellationOutcome === 'deadline';
  if (
    completedControl(baseline) &&
    completedControl(current) &&
    proof.cancellationComparison.baselineReleased &&
    proof.cancellationComparison.currentReleased
  ) {
    proof.cancellationComparison.status = 'observed';
  }
  assert.equal(failures.length, 0, 'one or more handler lifetime controls failed');
  proof.status = 'success';
} catch (error) {
  proof.status = 'failed';
  throw error;
} finally {
  await writeFile(path.join(directory, 'node-handler-lifetime.json'), `${JSON.stringify(proof)}\n`);
}
