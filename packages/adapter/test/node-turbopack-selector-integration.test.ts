import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { reviewedFrameworkSource } from '../src/node-manifest-framework.ts';
import {
  nativeTurbopackSelectorPatch,
  nativeTurbopackSelectorSource,
} from '../src/node-turbopack-selector.ts';

const ENABLED = process.env['UPWIND_NATIVE_FUNCTION_INTEGRATION'] === '1';
const ROUTES = ['pages', 'pages-api', 'app-page', 'app-route'] as const;

// Genuine published framework bytes belong only to the dedicated CI lane. Never evaluate them.
describe.skipIf(!ENABLED)('fixed native Turbopack selectors (dedicated CI)', () => {
  it.each(ROUTES)('specializes only the exact published %s selector', async (route) => {
    const require = createRequire(import.meta.url);
    const root = path.dirname(require.resolve('next/package.json'));
    const relative = `dist/server/route-modules/${route}/module.compiled.js`;
    const file = path.join(root, relative);
    const code = await readFile(file, 'utf8');

    expect(createHash('sha256').update(code).digest('hex')).toBe(reviewedFrameworkSource(relative));
    expect([...code.matchAll(/process\.env\.TURBOPACK/gu)]).toHaveLength(
      route.startsWith('app-') ? 4 : 2,
    );

    const specialized = nativeTurbopackSelectorSource(file, code);
    const policy = nativeTurbopackSelectorPatch.apply(code, file, {
      projectDir: root,
      distDir: path.join(root, '.next'),
      chunks: [],
      instrumentation: undefined,
      wasm: [],
    });

    expect(specialized).toBe(code.replaceAll('process.env.TURBOPACK', '"1"'));
    expect(policy.contents).toBe(specialized);
    expect(policy.edits).toBe(route.startsWith('app-') ? 4 : 2);
    expect(specialized).not.toBe(code);
    expect(nativeTurbopackSelectorSource(file, `${code}\n`)).toBe(`${code}\n`);
    expect(nativeTurbopackSelectorSource(path.join(root, 'unqualified.js'), code)).toBe(code);
  });
});
