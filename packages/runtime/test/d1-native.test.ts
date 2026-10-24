import { fileURLToPath } from 'node:url';

import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest';

import { bundleInlineWorker } from './inline-worker.ts';

const OBSERVER = fileURLToPath(new URL('../../core/src/paas/d1-observation.ts', import.meta.url));
const WORKER = String.raw`
import { observeD1 } from ${JSON.stringify(OBSERVER)};

export default {
  async fetch(request, env) {
    let warming = false;
    let reports = 0;
    const db = observeD1(env.DB, 'DB', {
      primaryReads: () => warming,
      changed: async () => { reports += 1; },
    });
    const path = new URL(request.url).pathname;
    if (path === '/binary') {
      const values = [
        new Uint8Array([1, 2]).buffer,
        new Uint8Array([0, 1, 2, 0]).subarray(1, 3),
        new Uint16Array([1, 2]),
        new Uint16Array([300]),
        new Float32Array([-1, 1.5]),
        new DataView(new Uint8Array([1, 2]).buffer),
      ];
      const rows = [];
      for (const value of values) {
        const sql = 'SELECT typeof(?1) AS kind, hex(?1) AS bytes';
        const native = env.DB.prepare(sql).bind(value);
        const observed = db.withSession('first-unconstrained').prepare(sql).bind(value);
        new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer).fill(99);
        warming = true;
        rows.push({ native: await native.first(), observed: await observed.first() });
        warming = false;
      }
      return Response.json({ rows, reports });
    }
    if (path === '/first') {
      const sql = 'SELECT 1 AS id';
      const native = await env.DB.prepare(sql).first('toString');
      const observed = await db.prepare(sql).first('toString');
      const own = await db.prepare('SELECT 7 AS "toString"').first('toString');
      return Response.json({ nativeType: typeof native, observedType: typeof observed, same: native === observed, own, reports });
    }
    if (path === '/values') {
      const sql = 'WITH x AS (SELECT 1) VALUES (2)';
      return Response.json({ native: await env.DB.prepare(sql).raw(), observed: await db.prepare(sql).raw(), reports });
    }
    if (path === '/batch-sessions') {
      const sql = 'SELECT ?1 AS id';
      const rootStatement = env.DB.prepare(sql).bind(3);
      const sessionStatement = env.DB.withSession('first-unconstrained').prepare(sql).bind(4);
      const native = await env.DB.withSession('first-primary').batch([
        rootStatement, sessionStatement, env.DB.prepare(sql).bind(5),
      ]);
      let primaryBatches = 0;
      let nativeStatementsKept = false;
      const facade = new Proxy(env.DB, {
        get(target, key) {
          if (key === 'withSession') return (constraint) => {
            const session = target.withSession(constraint);
            if (constraint !== 'first-primary') return session;
            return new Proxy(session, {
              get(selected, property) {
                if (property === 'batch') return (statements) => {
                  primaryBatches += 1;
                  nativeStatementsKept = statements[0] === rootStatement && statements[1] === sessionStatement;
                  return selected.batch(statements);
                };
                const value = Reflect.get(selected, property);
                return typeof value === 'function' ? value.bind(selected) : value;
              },
            });
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const observed = observeD1(facade, 'DB', {
        primaryReads: () => warming,
        changed: async () => { reports += 1; },
      });
      const observedStatement = observed.withSession('first-unconstrained').prepare(sql).bind(5);
      warming = true;
      const results = await observed.batch([rootStatement, sessionStatement, observedStatement]);
      return Response.json({
        native: native.map((result) => result.results),
        observed: results.map((result) => result.results),
        primaryBatches, nativeStatementsKept, reports,
      });
    }
    warming = true;
    const native = await env.DB.exec('SELECT 1\nSELECT 2');
    const observed = await db.exec('SELECT 1\nSELECT 2');
    const readReports = reports;
    const sessions = {
      nativeExec: typeof env.DB.withSession('first-primary').exec,
      observedExec: typeof db.withSession('first-primary').exec,
    };
    const written = await db.exec('SELECT 1\nCREATE TABLE items (id INTEGER)');
    const writtenReports = reports;
    let nativeContinuationError = false;
    let observedContinuationError = false;
    try { await env.DB.exec('SELECT count(*)\nFROM items'); }
    catch { nativeContinuationError = true; }
    try { await db.exec('SELECT count(*)\nFROM items'); }
    catch { observedContinuationError = true; }
    return Response.json({ native: native.count, observed: observed.count, readReports, sessions, written: written.count, writtenReports, nativeContinuationError, observedContinuationError });
  },
};
`;

/** Verify the observer against real D1 bindings, including quirks preserved from native workerd. */
describe('native D1 observation compatibility', () => {
  let runtime: Miniflare | undefined;

  beforeAll(async () => {
    const bundled = await bundleInlineWorker({
      stdin: {
        contents: WORKER,
        sourcefile: 'd1-native.mjs',
        resolveDir: fileURLToPath(new URL('../../core/src/', import.meta.url)),
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2024',
    });
    const output = bundled.outputFiles[0];
    assert(output !== undefined);
    runtime = new Miniflare({
      ...convertV4MiniflareOptions({
        workers: [
          {
            name: 'd1-native',
            modulesRoot: '/d1-native',
            modules: [{ type: 'ESModule', path: '/d1-native/index.mjs', contents: output.text }],
            d1Databases: { DB: 'd1-native-compatibility' },
            compatibilityDate: '2026-09-15',
          },
        ],
      }),
      log: new Log(LogLevel.NONE),
    });
    await runtime.ready;
  });

  afterAll(async () => {
    await runtime?.dispose();
  });

  async function answer(path: string): Promise<unknown> {
    assert(runtime !== undefined);
    const response = await runtime.dispatchFetch(new URL(path, 'https://d1.test'));
    return response.json();
  }

  it('keeps buffers and typed views as the same native BLOB after bind-time snapshots and primary reprepare', async () => {
    await expect(answer('/binary')).resolves.toStrictEqual({
      rows: [
        { native: { kind: 'blob', bytes: '0102' }, observed: { kind: 'blob', bytes: '0102' } },
        { native: { kind: 'blob', bytes: '0102' }, observed: { kind: 'blob', bytes: '0102' } },
        { native: { kind: 'blob', bytes: '0102' }, observed: { kind: 'blob', bytes: '0102' } },
        { native: { kind: 'blob', bytes: '2C' }, observed: { kind: 'blob', bytes: '2C' } },
        { native: { kind: 'blob', bytes: 'FF01' }, observed: { kind: 'blob', bytes: 'FF01' } },
        { native: { kind: 'blob', bytes: '' }, observed: { kind: 'blob', bytes: '' } },
      ],
      reports: 0,
    });
  });

  it('preserves native first column lookup for inherited names and actual columns', async () => {
    await expect(answer('/first')).resolves.toStrictEqual({
      nativeType: 'function',
      observedType: 'function',
      same: true,
      own: 7,
      reports: 0,
    });
  });

  it('keeps native exec line splitting and the absence of exec on sessions', async () => {
    await expect(answer('/exec')).resolves.toStrictEqual({
      native: 2,
      observed: 2,
      readReports: 0,
      sessions: { nativeExec: 'undefined', observedExec: 'undefined' },
      written: 2,
      writtenReports: 1,
      nativeContinuationError: true,
      observedContinuationError: true,
    });
  });

  it('does not report read-only WITH VALUES raw results as mutations', async () => {
    await expect(answer('/values')).resolves.toStrictEqual({
      native: [[2]],
      observed: [[2]],
      reports: 0,
    });
  });

  it('preserves native cross-session batch semantics and executes warm mixed batches once on the selected primary session', async () => {
    await expect(answer('/batch-sessions')).resolves.toStrictEqual({
      native: [[{ id: 3 }], [{ id: 4 }], [{ id: 5 }]],
      observed: [[{ id: 3 }], [{ id: 4 }], [{ id: 5 }]],
      primaryBatches: 1,
      nativeStatementsKept: true,
      reports: 0,
    });
  });
});
