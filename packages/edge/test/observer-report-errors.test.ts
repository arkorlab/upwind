import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { sendReport } from '../src/handlers/observer.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { RouteReport, RouteReports } from '../src/reports.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

function quiet(): void {
  // The tests inspect the warnings without printing them.
}

const REPORT: RouteReport = {
  kind: 'continuation-failure',
  reason: 'upstream-error',
  detail: undefined,
  projectId: 'site',
  manifestId: 'manifest',
  pathname: '/',
  colo: undefined,
};

/** A failed continuation triggers the host's reports through the public routing entrypoint. */
async function failedDocument(reports: RouteReports) {
  const { pointer } = await seedSite({ document: pprDocument() });
  const request = navigation('/');
  const ctx = createExecutionContext();
  const response = await serveFromPointer({
    request,
    url: new URL(request.url),
    env,
    ctx,
    runtime: standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      reports,
      dispatchApp: () => Promise.reject(new Error('the continuation failed')),
    }),
    host: standaloneHost(env),
    pointer,
    pointerMs: 0,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  const body = await response.text();
  return { response, body, ctx };
}

describe('route report delivery failures', () => {
  it.each([new Error('the reporter failed'), 'the reporter failed'])(
    'contains an async rejection after a public document answer: %s',
    async (reason) => {
      const warned = vi.spyOn(console, 'warn').mockImplementation(quiet);
      try {
        const reported: RouteReport[] = [];
        const result = await failedDocument({
          report: (report) => {
            reported.push(report);
            // A host can reject with a non-Error value too.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            return Promise.reject(reason);
          },
        });

        expect(result.response.status).toBe(200);
        expect(result.body).toContain('Loading');
        expect(reported.some((report) => report.kind === 'continuation-failure')).toBe(true);
        await expect(waitOnExecutionContext(result.ctx)).resolves.toBeUndefined();
        expect(warned).toHaveBeenCalledWith(
          expect.stringContaining('"message":"the host reports threw"'),
        );
        expect(warned).toHaveBeenCalledWith(
          expect.stringContaining('"kind":"continuation-failure"'),
        );
        expect(warned).toHaveBeenCalledWith(
          expect.stringContaining('"detail":"the reporter failed"'),
        );
      } finally {
        warned.mockRestore();
      }
    },
  );

  it('keeps successful async reporting behind the completed document body', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(quiet);
    const { promise: pending, resolve: finish } = Promise.withResolvers<undefined>();
    const reported: RouteReport[] = [];
    try {
      const result = await failedDocument({
        report: (report) => {
          reported.push(report);
          return pending;
        },
      });

      expect(result.body).toContain('Loading');
      expect(reported).not.toHaveLength(0);
      expect(warned).not.toHaveBeenCalledWith(
        expect.stringContaining('"message":"the host reports threw"'),
      );

      finish(undefined);

      await expect(waitOnExecutionContext(result.ctx)).resolves.toBeUndefined();
    } finally {
      finish(undefined);
      warned.mockRestore();
    }
  });

  it('keeps absent and declined reports synchronous', () => {
    expect(sendReport(undefined, REPORT)).toBeUndefined();
    expect(sendReport({ report: vi.fn<RouteReports['report']>() }, REPORT)).toBeUndefined();
  });

  it('retains synchronous throw containment and its log context', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(quiet);
    try {
      expect(
        sendReport(
          {
            report: () => {
              throw new Error('synchronous reporter failure');
            },
          },
          REPORT,
        ),
      ).toBeUndefined();
      expect(warned).toHaveBeenCalledWith(
        JSON.stringify({
          level: 'warn',
          message: 'the host reports threw',
          kind: 'continuation-failure',
          detail: 'synchronous reporter failure',
        }),
      );
    } finally {
      warned.mockRestore();
    }
  });
});
