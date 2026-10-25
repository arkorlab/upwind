import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { changedSinceBuild } from '../../src/preview/staleness.ts';

/** When the build was written, in the tests' own terms: files are set to either side of it. */
const BUILT = new Date('2026-10-25T00:00:00.000Z');
const BEFORE = new Date(BUILT.getTime() - 60_000);
const AFTER = new Date(BUILT.getTime() + 60_000);

/** A project of the files given, each written at the time given. */
function projectOf(files: Readonly<Record<string, Date>>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'upwind-preview-staleness-'));
  for (const [file, at] of Object.entries(files)) {
    const target = path.join(dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '');
    utimesSync(target, at, at);
  }
  return dir;
}

describe('what of a project changed after its build', () => {
  it('is nothing where every file is as old as the build or older', async () => {
    const dir = projectOf({ 'app/page.tsx': BEFORE, 'next.config.ts': BUILT });

    await expect(changedSinceBuild(dir, BUILT.getTime())).resolves.toStrictEqual({
      count: 0,
      named: [],
    });
  });

  it('names the files newer than the build, the nearest the root first, three at most', async () => {
    const dir = projectOf({
      '.env.local': AFTER,
      'app/blog/[slug]/page.tsx': AFTER,
      'app/page.tsx': AFTER,
      'package.json': AFTER,
      'public/.well-known/security.txt': AFTER,
      'tsconfig.json': BEFORE,
    });

    await expect(changedSinceBuild(dir, BUILT.getTime())).resolves.toStrictEqual({
      count: 5,
      named: ['.env.local', 'package.json', 'app/page.tsx'],
    });
  });

  it('skips what a build, an install or a tool writes for itself', async () => {
    const dir = projectOf({
      '.arkor/bundle.json': AFTER,
      '.git/index': AFTER,
      '.next/BUILD_ID': AFTER,
      '.upwind/deploy/cache-host.mjs': AFTER,
      'node_modules/next/package.json': AFTER,
      'out/index.html': AFTER,
      'packages/ui/node_modules/react/index.js': AFTER,
      'next-env.d.ts': AFTER,
      'tsconfig.tsbuildinfo': AFTER,
      // Of the project's own, though named as a written directory is beneath the root.
      'app/out/page.tsx': AFTER,
    });

    await expect(changedSinceBuild(dir, BUILT.getTime())).resolves.toStrictEqual({
      count: 1,
      named: ['app/out/page.tsx'],
    });
  });

  it('follows no link', async () => {
    const elsewhere = projectOf({ 'lib/shared.ts': AFTER });
    const dir = projectOf({ 'app/page.tsx': BEFORE });
    symlinkSync(path.join(elsewhere, 'lib'), path.join(dir, 'lib'));

    await expect(changedSinceBuild(dir, BUILT.getTime())).resolves.toStrictEqual({
      count: 0,
      named: [],
    });
  });
});
