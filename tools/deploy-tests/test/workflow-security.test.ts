import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/* eslint-disable sonarjs/no-os-command-from-path -- integration fixtures run the installed Git, GPG, and Bash using only private temporary files. */

/** `count` different projects of a host, as `ADAPTER_TEST_PROJECT_IDS` lists them. */
function projects(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `project-${String(index + 1)}`);
}

const CANARY_VERSION = '16.5.0-canary.25';
const CANARY_TAG = `v${CANARY_VERSION}`;
const CANARY_COMMIT = 'a'.repeat(40);
const STABLE_SCHEDULE = '23 17 * * *';
const CANARY_SCHEDULE = '23 18 * * *';

interface NetworkReply {
  readonly registry?: string;
  readonly curlStatus?: number;
  readonly refs?: string;
  readonly gitStatus?: number;
}

interface NetworkCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Every external lookup is answered locally, and recorded independently of its response. */
const NETWORK_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
fs.appendFileSync(process.env.PLAN_COMMAND_LOG, JSON.stringify({ command, args: process.argv.slice(2) }) + '\\n');
process.stdout.write(process.env[command === 'curl' ? 'PLAN_REGISTRY' : 'PLAN_REFS']);
process.exit(Number(process.env[command === 'curl' ? 'PLAN_CURL_STATUS' : 'PLAN_GIT_STATUS']));
`;

describe('workflow security', () => {
  const repository = path.resolve(import.meta.dirname, '../../..');
  const script = path.join(repository, '.github/scripts/verify-release.sh');
  const dirs: string[] = [];
  // GPG agent socket names must fit the Unix socket path limit, including on macOS.
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  let keys: string;
  const keyNames = [
    'Trusted Upwind Test <trusted@example.invalid>',
    'Other Upwind Test <other@example.invalid>',
  ];
  function temporary(): string {
    const dir = mkdtempSync(path.join(tempRoot, 'upwind-release-security-'));
    dirs.push(dir);
    return dir;
  }
  function git(dir: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GNUPGHOME: keys },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  beforeAll(() => {
    keys = mkdtempSync(path.join(tempRoot, 'upwind-release-keys-'));
    for (const name of keyNames)
      execFileSync(
        'gpg',
        [
          '--batch',
          '--pinentry-mode',
          'loopback',
          '--passphrase',
          '',
          '--quick-generate-key',
          name,
          'ed25519',
          'sign',
          '0',
        ],
        { env: { ...process.env, GNUPGHOME: keys }, stdio: 'pipe' },
      );
  }, 20_000);

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    spawnSync('gpgconf', ['--homedir', keys, '--kill', 'gpg-agent']);
    rmSync(keys, { recursive: true, force: true });
  });

  function fixture(): { work: string; trusted: string } {
    const base = temporary();
    const remote = path.join(base, 'remote.git');
    const work = path.join(base, 'work');
    mkdirSync(remote);
    mkdirSync(work);
    git(remote, 'init', '--bare');
    git(work, 'init', '--initial-branch=main');
    git(work, 'config', 'user.name', 'Release Test');
    git(work, 'config', 'user.email', 'release@example.invalid');
    git(work, 'config', 'gpg.program', 'gpg');
    git(work, 'remote', 'add', 'origin', remote);
    mkdirSync(path.join(work, '.github'));
    const policy = execFileSync('gpg', ['--armor', '--export', keyNames[0] ?? ''], {
      env: { ...process.env, GNUPGHOME: keys },
    });
    writeFileSync(path.join(work, '.github/release-signers.asc'), policy);
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'trusted policy');
    git(work, 'push', 'origin', 'main');
    return { work, trusted: git(work, 'rev-parse', 'HEAD') };
  }
  function tag(work: string, name: string, signer: string, message = 'test release'): void {
    git(work, '-c', 'gpg.format=openpgp', 'tag', '-s', '-u', signer, '-m', message, name);
    git(work, 'push', 'origin', `refs/tags/${name}`);
  }
  function verify(work: string, name: string) {
    const output = path.join(work, 'outputs');
    const result = spawnSync('bash', [script], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        TAG: name,
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: work,
      },
    });
    return { ...result, output };
  }

  describe('release verification binds policy, signature, tag name, ancestry, and checkout', () => {
    it('selects the signed commit even when a different branch has the tag name', () => {
      const { work, trusted } = fixture();
      tag(work, 'v1.0.0', keyNames[0] ?? '', 'test release\n\ntag fake-message-name');
      git(work, 'checkout', '-b', 'v1.0.0');
      writeFileSync(path.join(work, '.github/release-signers.asc'), 'attacker policy');
      git(work, 'add', '.');
      git(work, 'commit', '-m', 'shadow tag with branch');
      git(work, 'push', 'origin', 'refs/heads/v1.0.0');
      git(work, 'checkout', 'main');
      const result = verify(work, 'v1.0.0');

      expect(result.status).toBe(0);
      expect(readFileSync(result.output, 'utf8')).toContain(`commit=${trusted}\n`);
      expect(git(work, 'rev-parse', 'HEAD')).toBe(trusted);
      expect(git(work, 'rev-parse', 'HEAD')).not.toBe(git(work, 'rev-parse', 'refs/heads/v1.0.0'));
    });

    it('refuses a valid signature from an untrusted key', () => {
      const { work } = fixture();
      tag(work, 'v1.0.1', keyNames[1] ?? '');

      const result = verify(work, 'v1.0.1');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('release tag signature is not trusted');
      expect(existsSync(result.output)).toBe(false);
    });

    it('refuses a trusted signed tag object reused under a different release name', () => {
      const { work } = fixture();
      tag(work, 'v1.0.4', keyNames[0] ?? '', 'test release\n\ntag v2.0.0');
      git(work, 'update-ref', 'refs/tags/v2.0.0', git(work, 'rev-parse', 'refs/tags/v1.0.4'));
      git(work, 'push', 'origin', 'refs/tags/v2.0.0');

      const result = verify(work, 'v2.0.0');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('signed tag name does not match requested release tag');
      expect(existsSync(result.output)).toBe(false);
    });

    it('refuses a trusted signer on a commit outside the default-branch snapshot', () => {
      const { work } = fixture();
      git(work, 'checkout', '-b', 'outside');
      writeFileSync(path.join(work, 'outside'), 'unreviewed');
      git(work, 'add', '.');
      git(work, 'commit', '-m', 'outside main');
      tag(work, 'v1.0.2', keyNames[0] ?? '');
      git(work, 'checkout', 'main');

      const result = verify(work, 'v1.0.2');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('release tag is outside the trusted branch history');
      expect(existsSync(result.output)).toBe(false);
    });

    it('refuses lightweight tags without publishing a release revision', () => {
      const { work } = fixture();
      git(work, 'tag', 'v1.0.3');
      git(work, 'push', 'origin', 'refs/tags/v1.0.3');
      const result = verify(work, 'v1.0.3');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('release requires an annotated tag object');
      expect(existsSync(result.output)).toBe(false);
    });

    it('refuses multiline tags before publishing any output', () => {
      const { work } = fixture();
      const result = verify(work, 'v1.0.3\ncommit=forged');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('release tag must be a single line');
      expect(existsSync(result.output)).toBe(false);
    });
  });

  function deployTestsWorkflow(): string {
    return readFileSync(path.join(repository, '.github/workflows/deploy-tests.yaml'), 'utf8');
  }

  function workflowSetting(name: string): string {
    const line = deployTestsWorkflow()
      .split('\n')
      .find((entry) => entry.startsWith(`  ${name}: '`));
    const value = /^ {2}[A-Z_]+: '([^']+)'$/u.exec(line ?? '')?.[1];
    if (value === undefined) throw new Error(`the workflow sets no ${name}`);
    return value;
  }

  /** The plan step run as a dispatch of `ref` asks, with `asked` in place of what a test changes. */
  function plan(
    ref: string,
    asked: Readonly<Record<string, string>> = {},
    reply: NetworkReply = {},
  ) {
    const workflow = deployTestsWorkflow();
    const marker = '        run: |\n';
    const step = workflow
      .slice(workflow.indexOf(marker) + marker.length)
      .split('\n  deploy-tests:', 1)[0];
    const body = (step ?? '')
      .split('\n')
      .map((line) => (line.startsWith(' '.repeat(10)) ? line.slice(10) : line))
      .join('\n');
    const base = temporary();
    const output = path.join(base, 'output');
    const summaryFile = path.join(base, 'summary');
    const commandLog = path.join(base, 'commands');
    const bin = path.join(base, 'bin');
    mkdirSync(bin);
    for (const command of ['curl', 'git']) {
      writeFileSync(path.join(bin, command), NETWORK_STUB, { mode: 0o755 });
    }
    const result = spawnSync('bash', ['-c', body], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`,
        PLAN_COMMAND_LOG: commandLog,
        PLAN_REGISTRY: reply.registry ?? JSON.stringify({ canary: CANARY_VERSION }),
        PLAN_CURL_STATUS: String(reply.curlStatus ?? 0),
        PLAN_REFS: reply.refs ?? `${CANARY_COMMIT}\trefs/tags/${CANARY_TAG}\n`,
        PLAN_GIT_STATUS: String(reply.gitStatus ?? 0),
        EVENT: 'workflow_dispatch',
        SCHEDULE: '',
        TARGET: 'node',
        NEXTJS_REF: ref,
        NIGHTLY_NEXTJS_REF: workflowSetting('NIGHTLY_NEXTJS_REF'),
        RUNNER_SHARDS: workflowSetting('RUNNER_SHARDS'),
        TESTS: 'all',
        SHARDS: '1',
        ONLY: '',
        CONCURRENCY: '',
        CACHE: '',
        PROJECT_IDS: '',
        PROJECT_ID: '',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summaryFile,
        ...asked,
      },
    });
    const commands = existsSync(commandLog)
      ? readFileSync(commandLog, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as NetworkCommand)
      : [];
    const summary = existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '';
    return { ...result, output, commands, summary };
  }

  /** The most shards a host's whole manifest is cut into unasked, as the workflow sets it. */
  function hostShards(): number {
    return Number(workflowSetting('HOST_SHARDS'));
  }

  it.each(['v16.4.3\nmatrix={}', 'v16.4.3\rtotal=1', 'v16.4.3\r\nparallel=256', ''])(
    'rejects output injection before writing any plan output: %j',
    (ref) => {
      const result = plan(ref);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('nextjsRef must be a nonempty single line');
      expect(() => readFileSync(result.output)).toThrow(/ENOENT/u);
    },
  );

  it('preserves a normal ref and the validated shard plan', () => {
    const result = plan('v16.4.3');

    expect(result.status).toBe(0);
    expect(readFileSync(result.output, 'utf8')).toContain('nextjs=v16.4.3\n');
    expect(readFileSync(result.output, 'utf8')).toContain('total=1\nparallel=1\nconcurrency=2\n');
    expect(result.commands).toStrictEqual([]);
  });

  it.each([STABLE_SCHEDULE, CANARY_SCHEDULE])(
    'runs both local targets over the whole manifest on schedule %s',
    (schedule) => {
      const result = plan('ignored', {
        EVENT: 'schedule',
        SCHEDULE: schedule,
        TARGET: 'host',
        TESTS: 'ignored',
        ONLY: '9',
        CONCURRENCY: '8',
      });
      const total = Number(workflowSetting('RUNNER_SHARDS'));
      const matrix = {
        include: ['cloudflare', 'node'].flatMap((target) =>
          Array.from({ length: total }, (_, index) => ({ target, shard: index + 1 })),
        ),
      };
      const output = readFileSync(result.output, 'utf8');

      expect(result.status).toBe(0);
      expect(total).toBe(64);
      expect(matrix.include).toHaveLength(128);
      expect(deployTestsWorkflow()).toContain(`    - cron: '${schedule}'`);
      expect(output).toContain(`matrix=${JSON.stringify(matrix)}\n`);
      expect(output).toContain('total=64\nparallel=128\nconcurrency=2\n');
      expect(output).toContain('tests=all\ncache=none\n');
    },
  );

  function canaryPlan(reply: NetworkReply = {}) {
    return plan('', { EVENT: 'schedule', SCHEDULE: CANARY_SCHEDULE }, reply);
  }

  it('keeps the stable nightly release without querying npm or GitHub', () => {
    const result = plan('', { EVENT: 'schedule', SCHEDULE: STABLE_SCHEDULE });

    expect(result.status).toBe(0);
    expect(readFileSync(result.output, 'utf8')).toContain(
      `nextjs=${workflowSetting('NIGHTLY_NEXTJS_REF')}\n`,
    );
    expect(result.commands).toStrictEqual([]);
  });

  it('resolves the published Canary once and pins every shard to its exact release tag', () => {
    const result = canaryPlan();

    expect(result.status).toBe(0);
    expect(readFileSync(result.output, 'utf8')).toContain(`nextjs=${CANARY_COMMIT}\n`);
    expect(result.summary).toContain(`Next.js canary: ${CANARY_TAG} (${CANARY_COMMIT})`);
    expect(result.commands.map(({ command }) => command)).toStrictEqual(['curl', 'git']);
    expect(result.commands[0]?.args).toContain(
      'https://registry.npmjs.org/-/package/next/dist-tags',
    );
    expect(result.commands[1]?.args).toStrictEqual([
      'ls-remote',
      '--exit-code',
      'https://github.com/vercel/next.js.git',
      `refs/tags/${CANARY_TAG}`,
      `refs/tags/${CANARY_TAG}^{}`,
    ]);
  });

  it('pins an annotated Canary tag to its peeled commit instead of its tag object', () => {
    const tagObject = 'b'.repeat(40);
    const result = canaryPlan({
      refs: `${CANARY_COMMIT}\trefs/tags/${CANARY_TAG}^{}\n${tagObject}\trefs/tags/${CANARY_TAG}\n`,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(result.output, 'utf8')).toContain(`nextjs=${CANARY_COMMIT}\n`);
    expect(result.summary).toContain(`Next.js canary: ${CANARY_TAG} (${CANARY_COMMIT})`);
    expect(result.summary).not.toContain(tagObject);
  });

  it('rejects an unrecognized scheduled event instead of silently running the stable release', () => {
    const result = plan('', { EVENT: 'schedule', SCHEDULE: '23 19 * * *' });

    expect(result.status).not.toBe(0);
    expect(existsSync(result.output)).toBe(false);
    expect(result.commands).toStrictEqual([]);
  });

  it.each([
    undefined,
    null,
    25,
    [CANARY_VERSION],
    '',
    'canary',
    '16.5.0',
    '16.5.0-rc.25',
    '16.5.0-canary.*',
    `${CANARY_VERSION}\n`,
    `${CANARY_VERSION}\nmatrix={}`,
    `${CANARY_VERSION}\rtotal=1`,
  ])('rejects an invalid registry Canary before looking up its tag: %j', (canary) => {
    const result = canaryPlan({ registry: JSON.stringify({ canary }) });

    expect(result.status).not.toBe(0);
    expect(existsSync(result.output)).toBe(false);
    expect(result.commands.map(({ command }) => command)).toStrictEqual(['curl']);
  });

  it.each([
    { failure: 'HTTP failure', reply: { curlStatus: 22 } },
    { failure: 'invalid JSON', reply: { registry: '{' } },
  ])('fails planning without outputs on $failure', ({ reply }) => {
    const result = canaryPlan(reply);

    expect(result.status).not.toBe(0);
    expect(existsSync(result.output)).toBe(false);
    expect(result.commands.map(({ command }) => command)).toStrictEqual(['curl']);
  });

  it.each([
    { failure: 'tag lookup failure', reply: { gitStatus: 2 } },
    { failure: 'missing tag', reply: { refs: '' } },
    { failure: 'unrelated tag', reply: { refs: `${CANARY_COMMIT}\trefs/tags/v16.5.0\n` } },
    { failure: 'malformed commit', reply: { refs: `invalid\trefs/tags/${CANARY_TAG}\n` } },
    {
      failure: 'uppercase commit',
      reply: { refs: `${'A'.repeat(40)}\trefs/tags/${CANARY_TAG}\n` },
    },
  ])('fails planning without outputs on $failure', ({ reply }) => {
    const result = canaryPlan(reply);

    expect(result.status).not.toBe(0);
    expect(existsSync(result.output)).toBe(false);
    expect(result.commands.map(({ command }) => command)).toStrictEqual(['curl', 'git']);
  });

  it.each([
    { listed: 'five projects', ids: projects(5), total: 6, parallel: 1 },
    { listed: 'sixteen projects', ids: projects(16), total: 16, parallel: 16 },
    {
      listed: 'an id repeated eighth',
      ids: [...projects(7), 'project-1', 'project-8'],
      total: 7,
      parallel: 7,
    },
  ])(
    'cuts a host’s whole manifest into a shard a project when no shards are asked for: $listed',
    ({ ids, total, parallel }) => {
      const result = plan('v16.4.3', {
        TARGET: 'host',
        SHARDS: '',
        PROJECT_IDS: ids.join(' '),
        PROJECT_ID: '',
        HOST_SHARDS: String(hostShards()),
      });

      expect(result.status).toBe(0);
      expect(readFileSync(result.output, 'utf8')).toContain(
        `total=${String(total)}\nparallel=${String(parallel)}\nconcurrency=1\n`,
      );
    },
  );

  it('cuts a host’s whole manifest into no more shards than the workflow’s HOST_SHARDS', () => {
    const most = hostShards();
    const result = plan('v16.4.3', {
      TARGET: 'host',
      SHARDS: '',
      PROJECT_IDS: projects(most + 8).join(' '),
      PROJECT_ID: '',
      HOST_SHARDS: String(most),
    });

    expect(result.status).toBe(0);
    expect(readFileSync(result.output, 'utf8')).toContain(
      `total=${String(most)}\nparallel=${String(most)}\nconcurrency=1\n`,
    );
  });

  it('pins every downstream release checkout to the verification output', () => {
    const workflow = readFileSync(path.join(repository, '.github/workflows/publish.yaml'), 'utf8');

    expect(workflow).not.toMatch(/ref: \$\{\{ inputs\.tag \}\}/u);
    expect(workflow.match(/ref: \$\{\{ needs\.verify\.outputs\.commit \}\}/gu)).toHaveLength(3);
    expect(workflow).toContain('needs: [verify, publish]');
    expect(workflow).toContain('needs: [verify, provenance]');
  });
});
