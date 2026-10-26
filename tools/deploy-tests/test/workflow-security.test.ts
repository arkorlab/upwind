import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/* eslint-disable sonarjs/no-os-command-from-path -- integration fixtures run the installed Git, GPG, and Bash using only private temporary files. */

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

  function plan(ref: string) {
    const workflow = readFileSync(
      path.join(repository, '.github/workflows/deploy-tests.yaml'),
      'utf8',
    );
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
    const result = spawnSync('bash', ['-c', body], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT: 'workflow_dispatch',
        TARGET: 'node',
        NEXTJS_REF: ref,
        TESTS: 'all',
        SHARDS: '1',
        ONLY: '',
        CONCURRENCY: '',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: path.join(base, 'summary'),
      },
    });
    return { ...result, output };
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
  });

  it('pins every downstream release checkout to the verification output', () => {
    const workflow = readFileSync(path.join(repository, '.github/workflows/publish.yaml'), 'utf8');

    expect(workflow).not.toMatch(/ref: \$\{\{ inputs\.tag \}\}/u);
    expect(workflow.match(/ref: \$\{\{ needs\.verify\.outputs\.commit \}\}/gu)).toHaveLength(3);
    expect(workflow).toContain('needs: [verify, publish]');
    expect(workflow).toContain('needs: [verify, provenance]');
  });
});
