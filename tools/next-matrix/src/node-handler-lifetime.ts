import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import ts from 'typescript';

const REQUEST_MS = 10_000;
const CLEANUP_MS = 5000;
const HTTP_OK = 200;
const OBSERVER_BINDING = 'OBSERVER';
const ROOT = path.resolve(import.meta.dirname, '../../..');
const HOLD = '  retainHandler(dispatch.input, res, handled);';
const GUARDED_HOLD = [
  '  if (changesSomething(dispatch.input.request.method)) {',
  '    dispatch.input.waitUntil(handled);',
  '  }',
].join('\n');
const WORKER = `
import { invokeNodeHandler } from './node-bridge.mjs';
let held = 0;
let completed = false;
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/state') {
      return Response.json({ held, completed });
    }
    return invokeNodeHandler({
      request,
      requestMeta: {},
      waitUntil(pending) { held++; ctx.waitUntil(pending); },
      async handler(_request, response) {
        if (new URL(request.url).pathname === '/later-end') {
          const producer = await env.OBSERVER.fetch('https://observer.test/producer');
          await producer.text();
        }
        response.end('response before hook completion');
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

interface Lane {
  readonly kind: 'immediate-end' | 'later-end';
  producerEntered?: boolean;
  heldBeforeProducerEnd?: number;
  responseBeforeProducerEnd?: boolean;
  readonly method: 'GET' | 'POST';
  readonly mode: 'retained' | 'previous-method-guard';
  responseBeforeCompletion: boolean;
  hookStarted: boolean;
  held: number | undefined;
  completedAfterRelease: boolean;
  egressAttempts: number;
  stage: string;
  failureStage?: string;
}

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

/** Observe dispatch failures without leaving a rejected response promise unhandled at the gate. */
async function responseOutcome(
  pending: ReturnType<Miniflare['dispatchFetch']>,
  arrival: { value: boolean },
) {
  try {
    return { kind: 'response' as const, response: await pending };
  } catch (error) {
    return { kind: 'error' as const, error };
  } finally {
    arrival.value = true;
  }
}

/** Run the actual bridge in workerd; the observer is an in-process service, never the network. */
async function exercise(
  bridge: string,
  tasks: string,
  invocation: string,
  lane: Lane,
): Promise<void> {
  const release = Promise.withResolvers<undefined>();
  const producer = Promise.withResolvers<undefined>();
  const producerEntered = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  const completed = Promise.withResolvers<undefined>();
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'node-handler-lifetime',
      modulesRoot: '/lifetime',
      modules: [
        { type: 'ESModule', path: '/lifetime/worker.mjs', contents: WORKER },
        { type: 'ESModule', path: '/lifetime/node-bridge.mjs', contents: bridge },
        { type: 'ESModule', path: '/lifetime/tasks.mjs', contents: tasks },
        { type: 'ESModule', path: '/lifetime/invocation.ts', contents: invocation },
      ],
      // The Function pins these in packages/adapter/src/function.ts.
      compatibilityDate: '2026-09-15',
      compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
      cf: false,
      telemetry: { enabled: false },
      log: new Log(LogLevel.NONE),
      serviceBindings: {
        [OBSERVER_BINDING]: async (request) => {
          const pathname = new URL(request.url).pathname;
          if (pathname === '/producer') {
            lane.producerEntered = true;
            producerEntered.resolve(undefined);
            await producer.promise;
          } else if (pathname === '/hold') {
            lane.hookStarted = true;
            started.resolve(undefined);
            await release.promise;
          } else {
            assert.equal(pathname, '/completed');
            lane.completedAfterRelease = true;
            completed.resolve(undefined);
          }
          return new Response('observed');
        },
      },
      outboundService: () => {
        lane.egressAttempts += 1;
        throw new Error('Handler lifetime proof attempted outbound network');
      },
    }),
  );
  const signal = AbortSignal.timeout(REQUEST_MS);
  try {
    lane.stage = 'worker-start';
    await bounded(runtime.ready, signal);
    lane.stage = 'dispatch';
    const arrival = { value: false };
    const outcome = responseOutcome(
      runtime.dispatchFetch(
        `https://handler.test/${lane.kind === 'later-end' ? 'later-end' : 'respond'}`,
        { method: lane.method },
      ),
      arrival,
    );
    if (lane.kind === 'later-end') {
      lane.stage = 'producer-gate';
      await bounded(producerEntered.promise, signal);
      const observation = await bounded(
        runtime.dispatchFetch('https://handler.test/state'),
        signal,
      );
      const state = (await bounded(observation.json(), signal)) as State;
      lane.heldBeforeProducerEnd = state.held;
      lane.responseBeforeProducerEnd = arrival.value;
      assert.equal(state.held, 0, 'the open producer was retained before it ended');
      assert.equal(arrival.value, false, 'the producer gate did not hold the response');
      producer.resolve(undefined);
    }
    lane.stage = 'response-headers';
    const delivered = await bounded(outcome, signal);
    if (delivered.kind === 'error') throw delivered.error;
    const { response } = delivered;
    assert.equal(response.status, HTTP_OK);
    lane.stage = 'response-body';
    assert.equal(await bounded(response.text(), signal), 'response before hook completion');
    const expected = lane.mode === 'previous-method-guard' && lane.method === 'GET' ? 0 : 1;
    // An unretained GET can end before even the observer receives its first call. Only retained
    // lanes must reach that call; requiring it from the former guard would wait for cancelled work.
    if (expected === 1) {
      lane.stage = 'hook-start';
      await bounded(started.promise, signal);
    }
    lane.stage = 'held-state';
    const observation = await bounded(runtime.dispatchFetch('https://handler.test/state'), signal);
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
    producer.resolve(undefined);
    release.resolve(undefined);
    await bounded(runtime.dispose(), AbortSignal.timeout(CLEANUP_MS));
    assert.equal(lane.egressAttempts, 0);
  }
}

const source = await readFile(path.join(ROOT, 'packages/runtime/src/node-bridge.ts'), 'utf8');
assert.equal(source.split(HOLD).length, 2, 'the bridge lifetime boundary moved');
const previous = source.replace(HOLD, () => GUARDED_HOLD);
const tasks = compiled(await readFile(path.join(ROOT, 'packages/runtime/src/tasks.ts'), 'utf8'));
const invocation = compiled(
  await readFile(path.join(ROOT, 'packages/runtime/src/invocation.ts'), 'utf8'),
);
const lanes: Lane[] = [];
const failures: {
  readonly kind: Lane['kind'];
  readonly method: Lane['method'];
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
  scope: 'finite Node handler completion only; no actual stream-cancellation claim',
};
const directory = process.env['UPWIND_MATRIX_PROOF_DIR'] ?? path.join(ROOT, '.node-handler-proof');
await mkdir(directory, { recursive: true });
async function collect(bridge: string, lane: Lane): Promise<void> {
  lanes.push(lane);
  try {
    await exercise(bridge, tasks, invocation, lane);
  } catch (error) {
    failures.push({
      kind: lane.kind,
      method: lane.method,
      mode: lane.mode,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
try {
  for (const mode of ['previous-method-guard', 'retained'] as const) {
    const bridge = compiled(mode === 'retained' ? source : previous).replace(
      "'./tasks.ts'",
      "'./tasks.mjs'",
    );
    for (const method of ['GET', 'POST'] as const) {
      const lane: Lane = {
        kind: 'immediate-end',
        mode,
        method,
        responseBeforeCompletion: false,
        hookStarted: false,
        held: undefined,
        completedAfterRelease: false,
        egressAttempts: 0,
        stage: 'created',
      };
      await collect(bridge, lane);
    }
  }
  const later: Lane = {
    kind: 'later-end',
    mode: 'retained',
    method: 'GET',
    responseBeforeCompletion: false,
    hookStarted: false,
    held: undefined,
    completedAfterRelease: false,
    egressAttempts: 0,
    stage: 'created',
  };
  await collect(compiled(source).replace("'./tasks.ts'", "'./tasks.mjs'"), later);
  assert.equal(failures.length, 0, 'one or more finite handler lifetime controls failed');
  proof.status = 'success';
} catch (error) {
  proof.status = 'failed';
  throw error;
} finally {
  await writeFile(path.join(directory, 'node-handler-lifetime.json'), `${JSON.stringify(proof)}\n`);
}
