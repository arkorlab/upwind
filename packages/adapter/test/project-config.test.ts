import { execFile as execFileCallback } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { CONFIG_FILES, configFileOrder, readProjectConfig } from '../src/project-config.ts';

function projectWith(file: string, value: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'upwind-project-config-'));
  writeFileSync(path.join(dir, file), JSON.stringify(value));
  return dir;
}

describe("a project's deploy settings", () => {
  it('are read from its own file, whole', async () => {
    const deploy = {
      name: 'shop',
      workersDev: false,
      hostnames: ['shop.example.com'],
      keep: 3,
      storage: { UPWIND_D1: 'd1', MEDIA: 'r2' },
      secrets: ['AUTH_SECRET'],
      images: true,
      checks: ['/', '/api/health'],
      cspNonce: { mode: 'report-only', strictDynamic: true },
      logs: true,
    };
    const config = await readProjectConfig(projectWith('upwind.json', { deploy }));

    expect(config).toStrictEqual({ file: 'upwind.json', crons: [], deploy });
  });

  it('are not there where the project wrote none', async () => {
    await expect(readProjectConfig(projectWith('upwind.json', {}))).resolves.toStrictEqual({
      file: 'upwind.json',
      crons: [],
    });
  });

  it('are never read from vercel.json', async () => {
    await expect(
      readProjectConfig(projectWith('vercel.json', { deploy: { name: 'shop' } })),
    ).resolves.toStrictEqual({ file: 'vercel.json', crons: [] });
  });

  it('refuse a key they do not know, which would be a setting silently not applied', async () => {
    await expect(
      readProjectConfig(projectWith('upwind.json', { deploy: { keepVersions: 3 } })),
    ).rejects.toThrow(/upwind\.json: deploy/u);
  });

  it('refuse a name, a hostname or a check no deploy could use', async () => {
    for (const deploy of [
      { name: 'Shop' },
      { name: 'a--b' },
      { name: 'x'.repeat(25) },
      { hostnames: ['https://shop.example.com'] },
      { hostnames: ['localhost'] },
      { checks: ['//evil.example'] },
      { keep: 51 },
      { storage: { DB: 'queue' } },
    ]) {
      await expect(readProjectConfig(projectWith('upwind.json', { deploy }))).rejects.toThrow(
        /upwind\.json: deploy/u,
      );
    }
  });
});

/**
 * What a project may declare beyond `next.config`, and which file it is read from.
 *
 * Each case gets a directory of its own: a `.ts` config is imported, and Node caches a module by
 * URL, so a second test writing the same path would read the first one's module.
 */

const execFile = promisify(execFileCallback);
const directories: string[] = [];

async function projectDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'adapter-config-'));
  directories.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(dir, name), contents);
  }
  return dir;
}

const CRON = { path: '/api/cron', schedule: '0 5 * * *' };
/** What a host called the file before the adapter had a name of its own, and still answers to. */
const EARLIER = ['host.config.ts', 'host.jsonc', 'host.json'];

describe('readProjectConfig', () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('declares nothing for a project with no configuration file', async () => {
    await expect(readProjectConfig(await projectDir({}))).resolves.toStrictEqual({
      file: undefined,
      crons: [],
    });
  });

  it('reads the crons of a vercel.json, as a project moving here already has one', async () => {
    const dir = await projectDir({
      'vercel.json': JSON.stringify({
        $schema: 'https://openapi.vercel.sh/vercel.json',
        crons: [CRON],
      }),
    });

    await expect(readProjectConfig(dir)).resolves.toStrictEqual({
      file: 'vercel.json',
      crons: [CRON],
    });
  });

  it('reads an upwind.json', async () => {
    const dir = await projectDir({ 'upwind.json': JSON.stringify({ crons: [CRON] }) });

    await expect(readProjectConfig(dir)).resolves.toStrictEqual({
      file: 'upwind.json',
      crons: [CRON],
    });
  });

  it('reads an upwind.jsonc with the comments and trailing commas the name promises', async () => {
    const dir = await projectDir({
      'upwind.jsonc': `{
  // The nightly sweep.
  "crons": [
    /* one job */
    { "path": "/api/cron", "schedule": "0 5 * * *" },
  ],
}`,
    });

    await expect(readProjectConfig(dir)).resolves.toStrictEqual({
      file: 'upwind.jsonc',
      crons: [CRON],
    });
  });

  it('refuses a comment in an upwind.json, where the name does not promise one', async () => {
    const dir = await projectDir({ 'upwind.json': '{ // no\n"crons": [] }' });

    await expect(readProjectConfig(dir)).rejects.toThrow(/upwind\.json/u);
  });

  it('reads an upwind.config.ts through Node, types and all', async () => {
    const dir = await projectDir({
      'upwind.config.ts': `const schedule: string = '0 5 * * *';
export default { crons: [{ path: '/api/cron', schedule }] } satisfies {
  crons: { path: string; schedule: string }[];
};
`,
    });

    await expect(readProjectConfig(dir)).resolves.toStrictEqual({
      file: 'upwind.config.ts',
      crons: [CRON],
    });
  });

  it('calls an upwind.config.ts that exports a function, so a declaration can be computed', async () => {
    const dir = await projectDir({
      'upwind.config.ts': `export default async () => ({
  crons: [1, 2].map((n) => ({ path: \`/api/cron/\${n}\`, schedule: '0 5 * * *' })),
});
`,
    });

    await expect(readProjectConfig(dir)).resolves.toStrictEqual({
      file: 'upwind.config.ts',
      crons: [
        { path: '/api/cron/1', schedule: '0 5 * * *' },
        { path: '/api/cron/2', schedule: '0 5 * * *' },
      ],
    });
  });

  /**
   * The same, run by Node itself rather than by the test runner's transform.
   *
   * `next build` loads this adapter in Node, and it is Node's own type stripping that has to read
   * an `upwind.config.ts` — a transform that is more forgiving than Node's would let a config
   * through here and fail the build.
   */
  it('is read by Node itself, whose type stripping is what a build has', async () => {
    const dir = await projectDir({
      'upwind.config.ts': `interface Job { path: string; schedule: string }
const crons: Job[] = [{ path: '/api/cron', schedule: '0 5 * * *' }];
export default { crons };
`,
    });
    const loader = path.join(import.meta.dirname, '../src/project-config.ts');
    const { stdout } = await execFile(process.execPath, [
      '--input-type=module',
      '-e',
      `const { readProjectConfig } = await import(${JSON.stringify(pathToFileURL(loader).href)});
       process.stdout.write(JSON.stringify(await readProjectConfig(${JSON.stringify(dir)})));`,
    ]);

    expect(JSON.parse(stdout)).toStrictEqual({ file: 'upwind.config.ts', crons: [CRON] });
  });

  it('fails the build with the file’s name when the config’s own code throws', async () => {
    const dir = await projectDir({
      'upwind.config.ts': "export default () => { throw new Error('no schedule for you'); };\n",
    });

    await expect(readProjectConfig(dir)).rejects.toThrow(
      /upwind\.config\.ts: no schedule for you/u,
    );
  });

  it('refuses an upwind.config.ts with no default export', async () => {
    const dir = await projectDir({ 'upwind.config.ts': 'export const crons = [];\n' });

    await expect(readProjectConfig(dir)).rejects.toThrow(/expected a default export/u);
  });

  /**
   * The files are not merged: the first one that exists is the whole of the configuration. A
   * project that has moved keeps its `vercel.json` for Vercel, and what it tells this adapter is
   * in the file named after it.
   */
  it('reads the first file of the order and no other', async () => {
    const dir = await projectDir({
      'upwind.jsonc': JSON.stringify({ crons: [CRON] }),
      'upwind.json': JSON.stringify({ crons: [{ path: '/api/json', schedule: '0 5 * * *' }] }),
      'vercel.json': JSON.stringify({ crons: [{ path: '/api/vercel', schedule: '0 5 * * *' }] }),
    });

    await expect(readProjectConfig(dir)).resolves.toStrictEqual({
      file: 'upwind.jsonc',
      crons: [CRON],
    });
  });

  it('looks for the files in the documented order', () => {
    expect([...CONFIG_FILES]).toStrictEqual([
      'upwind.config.ts',
      'upwind.jsonc',
      'upwind.json',
      'vercel.json',
    ]);
  });

  /**
   * A host that read the same file under an earlier name keeps reading it, after this adapter's own
   * names and before `vercel.json`. A build that simply stopped looking would read an empty
   * configuration from a project that wrote one — not no configuration — and the crons it declares
   * would be taken as withdrawn.
   */
  it("reads a host's earlier names after its own and before Vercel's", () => {
    expect([...configFileOrder(EARLIER)]).toStrictEqual([
      'upwind.config.ts',
      'upwind.jsonc',
      'upwind.json',
      ...EARLIER,
      'vercel.json',
    ]);
    expect([...configFileOrder()]).toStrictEqual([...CONFIG_FILES]);
  });

  it("reads the crons out of a host's earlier file", async () => {
    const dir = await projectDir({ 'host.jsonc': JSON.stringify({ crons: [CRON] }) });

    await expect(readProjectConfig(dir, EARLIER)).resolves.toStrictEqual({
      file: 'host.jsonc',
      crons: [CRON],
    });
  });

  it("prefers this adapter's own name to a host's earlier one", async () => {
    const dir = await projectDir({
      'upwind.json': JSON.stringify({ crons: [CRON] }),
      'host.json': JSON.stringify({ crons: [{ path: '/api/old', schedule: '0 6 * * *' }] }),
    });

    await expect(readProjectConfig(dir, EARLIER)).resolves.toStrictEqual({
      file: 'upwind.json',
      crons: [CRON],
    });
  });

  it("prefers a host's earlier name to a vercel.json", async () => {
    const dir = await projectDir({
      'host.jsonc': JSON.stringify({ crons: [CRON] }),
      'vercel.json': JSON.stringify({ crons: [{ path: '/api/vercel', schedule: '0 7 * * *' }] }),
    });

    await expect(readProjectConfig(dir, EARLIER)).resolves.toStrictEqual({
      file: 'host.jsonc',
      crons: [CRON],
    });
  });

  it('reads nothing of an earlier name a host does not answer to', async () => {
    const dir = await projectDir({ 'host.jsonc': JSON.stringify({ crons: [CRON] }) });

    await expect(readProjectConfig(dir)).resolves.toStrictEqual({ file: undefined, crons: [] });
  });

  it('ignores the keys of a vercel.json that are not this adapter’s to honour', async () => {
    const dir = await projectDir({
      'vercel.json': JSON.stringify({
        crons: [CRON],
        // `next.config` is where this adapter reads routing from; these are not read at all.
        rewrites: [{ source: '/a', destination: '/b' }],
        regions: ['iad1'],
      }),
    });

    await expect(readProjectConfig(dir)).resolves.toStrictEqual({
      file: 'vercel.json',
      crons: [CRON],
    });
  });

  it.each([
    ['a schedule with a day name', { crons: [{ path: '/api/cron', schedule: '0 0 * * MON' }] }],
    ['a schedule with six fields', { crons: [{ path: '/api/cron', schedule: '0 0 0 * * *' }] }],
    ['a path that is a URL', { crons: [{ path: 'https://x.test/a', schedule: '0 5 * * *' }] }],
    ['crons that are not a list', { crons: { path: '/a', schedule: '0 5 * * *' } }],
  ])('fails the build on %s', async (_case, config) => {
    const dir = await projectDir({ 'upwind.json': JSON.stringify(config) });

    await expect(readProjectConfig(dir)).rejects.toThrow(/@stayingupwind\/adapter: upwind\.json/u);
  });

  it('fails the build on a file that will not parse', async () => {
    const dir = await projectDir({ 'vercel.json': '{ "crons": [' });

    await expect(readProjectConfig(dir)).rejects.toThrow(/vercel\.json/u);
  });

  it.each([
    ['off', false],
    ['on', true],
    ['on budgets of its own', { maxMiB: 30, maxCodeMiB: 8 }],
  ])("reads a project's split %s from an upwind.json", async (_case, split) => {
    const dir = await projectDir({ 'upwind.json': JSON.stringify({ functions: { split } }) });

    await expect(readProjectConfig(dir)).resolves.toStrictEqual({
      file: 'upwind.json',
      crons: [],
      split,
    });
  });

  it('refuses a split budget it would otherwise silently not apply', async () => {
    const dir = await projectDir({
      'upwind.json': JSON.stringify({ functions: { split: { maxCodeMB: 8 } } }),
    });

    await expect(readProjectConfig(dir)).rejects.toThrow(/@stayingupwind\/adapter: upwind\.json/u);
  });

  it("reads nothing of a vercel.json's functions, which are Vercel's own settings", async () => {
    const dir = await projectDir({
      'vercel.json': JSON.stringify({
        crons: [CRON],
        functions: { 'api/*.ts': { memory: 1024, maxDuration: 10 } },
      }),
    });

    await expect(readProjectConfig(dir)).resolves.toStrictEqual({
      file: 'vercel.json',
      crons: [CRON],
    });
  });
});
