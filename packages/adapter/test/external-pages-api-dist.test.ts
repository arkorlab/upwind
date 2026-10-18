import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { assert, describe, expect, it, vi } from 'vitest';

import {
  auditExternalPagesApiDist,
  EXTERNAL_PAGES_API_DIST_PATCH,
  externalPagesApiDistPatch,
} from '../src/patches/external-pages-api-dist.ts';
import { patchesPlugin } from '../src/patches/rolldown.ts';
import { type PatchContext, PatchError } from '../src/patches/types.ts';

const EXTERNAL: PatchContext = {
  projectDir: '/workspace/apps/web',
  distDir: '/workspace/dist/apps/web/.next',
  chunks: [],
  instrumentation: undefined,
  wasm: [],
};
const NORMAL: PatchContext = { ...EXTERNAL, distDir: '/workspace/apps/web/.next' };
const SOURCE = 'class Route {constructor(r,p){this.distDir=r,this.relativeProjectDir=p}}';
const FILE = '/node_modules/next/dist/compiled/next-server/pages-api-turbo.runtime.prod.js';

describe('the private Pages API route output directory', () => {
  it('normalizes the private constructor before the instance can read a manifest', () => {
    const result = externalPagesApiDistPatch.apply(SOURCE, FILE, EXTERNAL);
    const scope: { route?: { distDir: string; relativeProjectDir: string } } = {};
    // eslint-disable-next-line sonarjs/code-eval -- evaluate only the generated test class, not application code.
    runInNewContext(
      `${result.contents};route = new Route('../../dist/apps/web/.next', '.');`,
      scope,
    );

    expect(scope.route?.distDir).toBe('.upwind-build');
    expect(scope.route?.relativeProjectDir).toBe('.');
    expect(result.edits).toBe(1);
  });

  it.each(['pages-api.runtime.prod.js', 'pages-api-turbo.runtime.prod.js'])(
    'matches the installed Next.js %s constructor exactly once',
    async (name) => {
      const require = createRequire(import.meta.url);
      const next = path.dirname(require.resolve('next/package.json'));
      const file = path.join(next, 'dist', 'compiled', 'next-server', name);
      const source = await readFile(file, 'utf8');
      const result = externalPagesApiDistPatch.apply(source, file, EXTERNAL);

      expect(externalPagesApiDistPatch.target.test(file)).toBe(true);
      expect(result.edits).toBe(1);
      expect(result.contents).toContain('this.distDir=".upwind-build",this.relativeProjectDir=');
    },
  );

  it('leaves normal output bytes unchanged', () => {
    expect(externalPagesApiDistPatch.apply(SOURCE, FILE, NORMAL)).toStrictEqual({
      contents: SOURCE,
      edits: 0,
      notes: [],
    });
  });

  it('skips the registry load and record entirely for normal output', async () => {
    const applied = vi.fn();
    const plugin = patchesPlugin([externalPagesApiDistPatch], NORMAL, applied);
    const load = plugin.load;
    assert.ok(load !== undefined && typeof load !== 'function');
    const result = await load.handler.call({} as never, FILE);

    expect(result).toBeNull();
    expect(applied).not.toHaveBeenCalled();
  });

  it.each([
    'class Route {constructor(r,p){this.distDir=r;this.relativeProjectDir=p}}',
    'class Route {constructor(r,p){this.output=r,this.relativeProjectDir=p}}',
    `${SOURCE};${SOURCE.replace('class Route', 'class Other')}`,
  ])('rejects a missing, changed or duplicated constructor', (source) => {
    expect(() => externalPagesApiDistPatch.apply(source, FILE, EXTERNAL)).toThrow(PatchError);
  });

  it.each(['api.js', 'api/pages-api.js'])(
    'refuses external %s when no runtime matched the private constructor patch',
    (name) => {
      const entries = [{ filePath: path.join(EXTERNAL.distDir, 'server', 'pages', name) }];

      expect(() => {
        auditExternalPagesApiDist(EXTERNAL.projectDir, EXTERNAL.distDir, entries, []);
      }).toThrow('no private route constructor');
    },
  );

  it('accepts a verified constructor rewrite', () => {
    const entries = [
      { filePath: path.join(EXTERNAL.distDir, 'server', 'pages', 'api', 'hello.js') },
    ];

    expect(() => {
      auditExternalPagesApiDist(EXTERNAL.projectDir, EXTERNAL.distDir, entries, [
        { patch: EXTERNAL_PAGES_API_DIST_PATCH },
      ]);
    }).not.toThrow();
  });

  it('requires no private Pages API rewrite for App routes or normal output', () => {
    const app = [{ filePath: path.join(EXTERNAL.distDir, 'server', 'app', 'api', 'route.js') }];
    const pages = [{ filePath: path.join(NORMAL.distDir, 'server', 'pages', 'api', 'hello.js') }];

    expect(() => {
      auditExternalPagesApiDist(EXTERNAL.projectDir, EXTERNAL.distDir, app, []);
    }).not.toThrow();
    expect(() => {
      auditExternalPagesApiDist(NORMAL.projectDir, NORMAL.distDir, pages, []);
    }).not.toThrow();
  });
});
