import { FUNCTION_HEADER, MISDIRECTED_STATUS } from '@stayingupwind/core/paas';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, tracing } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { EdgeRuntime } from '../src/edge-runtime.ts';
import { dispatchesMade, fetchUpstream } from '../src/handlers/upstream.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

function recordSpans(names: string[]): NonNullable<EdgeRuntime['tracing']> {
  return {
    enterSpan(name, callback, ...args) {
      names.push(name);
      return tracing.enterSpan(name, callback, ...args);
    },
  };
}

describe('edge delivery spans', () => {
  it('starts both lookups immediately and serves the shell while its resume is pending', async () => {
    const document = pprDocument();
    const { pointer } = await seedSite({ document });
    const names: string[] = [];
    const resume = Promise.withResolvers<Response>();
    const ctx = createExecutionContext();
    const request = navigation('/?private-query=visitor', {
      headers: { 'accept-encoding': 'identity' },
    });
    const response = serveFromPointer({
      request,
      url: new URL(request.url),
      env,
      ctx,
      host: standaloneHost(env),
      runtime: standaloneRuntime(env, {
        memory: createEdgeMemory(() => Date.now()),
        tracing: recordSpans(names),
        dispatchApp: () => resume.promise,
      }),
      pointer,
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    });
    const started = [...names];
    const delivered = await response;
    const reader = delivered.body!.pipeThrough(new TextDecoderStream()).getReader();
    try {
      expect(started).toStrictEqual(['edge.policy', 'edge.manifest']);
      expect((await reader.read()).value).toContain('<!DOCTYPE html>');
      expect(names).toStrictEqual(['edge.policy', 'edge.manifest', 'edge.shell', 'edge.resume']);
    } finally {
      resume.resolve(htmlResponse(document.suffix));
      while (!(await reader.read()).done) {
        // Drain the continuation and allow background reporting to finish.
      }
      reader.releaseLock();
      await waitOnExecutionContext(ctx);
    }
  });

  it('counts both split dispatch attempts while the second is still waiting for headers', async () => {
    const names: string[] = [];
    const second = Promise.withResolvers<Response>();
    const askedAgain = Promise.withResolvers<void>();
    const runtime = standaloneRuntime(env, {
      tracing: recordSpans(names),
      dispatchApp: (script) => {
        if (script === 'first') {
          return Promise.resolve(
            new Response(null, {
              status: MISDIRECTED_STATUS,
              headers: { [FUNCTION_HEADER]: 'app-2' },
            }),
          );
        }
        askedAgain.resolve();
        return second.promise;
      },
    });
    const pending = fetchUpstream(
      runtime,
      {
        deploymentId: 'site',
        scriptName: 'first',
        functions: { 'app-2': 'second' },
      },
      navigation('/'),
    );
    await askedAgain.promise;
    const answer = new Response('streamed');
    try {
      expect(dispatchesMade(pending)).toBe(2);
      expect(names).toStrictEqual(['edge.dispatch', 'edge.dispatch']);
    } finally {
      second.resolve(answer);
    }
    expect(await pending).toBe(answer);
    expect(answer.bodyUsed).toBe(false);
  });
});
