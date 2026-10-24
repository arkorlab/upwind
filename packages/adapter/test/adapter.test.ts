import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { NextAdapter } from 'next';
import { describe, expect, it, vi } from 'vitest';

import adapter from '../src/index.ts';
import { projectDirOf } from '../src/project-dir.ts';

/**
 * What the adapter says about the config before anything is compiled. This is where a setting the
 * host cannot honour has to be refused: `onBuildComplete` runs after the build, too late to
 * save the time, and a config that skips this hook is caught there instead.
 */

type ModifyConfig = NonNullable<NextAdapter['modifyConfig']>;
type Config = Parameters<ModifyConfig>[0];
type Context = Parameters<ModifyConfig>[1];

const BUILD = { phase: 'phase-production-build', projectDir: '/project' } as Context;

/**
 * Next.js hands the hook a config with its defaults already in, `experimental` among them — the
 * adapter reads `experimental.cpus` off it — so what a test leaves out is what Next.js would fill.
 *
 * Awaited: the hook may write a module of the host's into the build before it names it
 * (`clientInstrumentationSource`), so it is async whether or not a host asked for one.
 */
async function modify(config: Partial<Config>): Promise<Config> {
  return (await adapter.modifyConfig?.({ experimental: {}, ...config } as Config, BUILD))!;
}

/** What 16.2 hands the hook: its phase and its version, and no project directory. */
const RELEASE_16_2 = { phase: 'phase-production-build', nextVersion: '16.2.0' } as Context;

const nodeRequire = createRequire(import.meta.url);

/**
 * What 16.2's `next build` records before it loads the config: the directory it was given, in the
 * build context module of the Next.js that is running (`NextBuildContext`). A module by that name,
 * loaded for the length of `run` and taken out of the registry after.
 */
async function withRecordedBuildDir<T>(dir: string, run: () => T): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'adapter-build-context-'));
  const file = path.join(root, 'node_modules', 'next', 'dist', 'build', 'build-context.js');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `exports.NextBuildContext = { dir: ${JSON.stringify(dir)} };\n`);
  const loaded = nodeRequire.resolve(file);
  nodeRequire(loaded);
  try {
    return run();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a module's registry entry is keyed by its path
    delete nodeRequire.cache[loaded];
    await rm(root, { recursive: true, force: true });
  }
}

describe('modifyConfig', () => {
  it('asks for content-addressed immutable assets', async () => {
    expect((await modify({})).supportsImmutableAssets).toBe(true);
  });

  /**
   * 16.4 collapses the route table it hands an adapter by default: a dynamic page and its `.rsc` and
   * segment forms in one entry, a run of fallback shells in another. The bundle carries the table as
   * the build wrote it and reads it back where it needs a page's name (`pageRoutes`), so the option
   * is the application's: its default, and whatever the application set.
   */
  it("leaves the route table as Next.js's default collapses it", async () => {
    const { defaultConfig } = await import('next/dist/server/config-shared.js');
    // Next.js's own defaults, which its type for them declares apart from the complete config's.
    const defaults: unknown = { ...defaultConfig.experimental };
    const config = await modify({ experimental: defaults as Config['experimental'] });

    expect(defaultConfig.experimental.collapseAdapterRoutes).toBe(true);
    expect(config.experimental.collapseAdapterRoutes).toBe(true);
  });

  it('leaves the option off where the application turned it off', async () => {
    const config = await modify({
      experimental: { collapseAdapterRoutes: false } as Config['experimental'],
    });

    expect(config.experimental.collapseAdapterRoutes).toBe(false);
  });

  /** A release before 16.4 has no such option, and is handed none that its config would not know. */
  it('adds nothing to a release that has no such option', async () => {
    const config = await modify({});

    expect(Object.hasOwn(config.experimental, 'collapseAdapterRoutes')).toBe(false);
  });

  /**
   * 16.2 hands the hook its phase and its version and no project directory (16.3 added one), and
   * the hook needs one for the Workflow SDK's Worlds; `projectDirOf`, below, is where it comes from.
   */
  it('runs where a release names no project directory', async () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/nowhere');
    try {
      await expect(
        adapter.modifyConfig?.({ experimental: {} } as Config, RELEASE_16_2),
      ).resolves.toBeDefined();

      expect(cwd).toHaveBeenCalledWith();
    } finally {
      cwd.mockRestore();
    }
  });

  /**
   * A custom cache handler was refused here once, when the Function could not load a module by path.
   * It is bundled into the Function now (`cache-handlers.ts`), so the config is taken as it is, the
   * handler's path left where Next.js resolves and records it.
   */
  it('takes a custom cache handler, leaving its path to Next.js', async () => {
    const config = await modify({
      cacheHandler: '/app/cache-handler.js',
      cacheHandlers: { default: '/app/handler.js' },
    });

    expect(config.cacheHandler).toBe('/app/cache-handler.js');
    expect(config.cacheHandlers).toStrictEqual({ default: '/app/handler.js' });
  });

  it('takes one in a static export too, which loads no handler at all', async () => {
    await expect(
      modify({ output: 'export', cacheHandler: '/app/cache-handler.js' }),
    ).resolves.toBeDefined();
  });
});

/**
 * 16.2 hands `modifyConfig` no project directory, but its `next build` has recorded the one it was
 * given by the time the hook runs: `next build apps/site` from the root of a repository is a build
 * of `apps/site`, whether the project has a config of its own or takes the root's.
 */
describe('projectDirOf', () => {
  it('takes the directory a 16.2 build recorded, wherever the build runs from', async () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/repo');
    try {
      await expect(
        withRecordedBuildDir('/repo/apps/site', () => projectDirOf(RELEASE_16_2)),
      ).resolves.toBe('/repo/apps/site');
    } finally {
      cwd.mockRestore();
    }
  });

  it('takes the working directory where no build has recorded one', () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/repo/apps/site');
    try {
      expect(projectDirOf(RELEASE_16_2)).toBe('/repo/apps/site');
    } finally {
      cwd.mockRestore();
    }
  });

  it('takes the directory a release names over anything recorded', async () => {
    await expect(withRecordedBuildDir('/elsewhere', () => projectDirOf(BUILD))).resolves.toBe(
      '/project',
    );
  });
});
