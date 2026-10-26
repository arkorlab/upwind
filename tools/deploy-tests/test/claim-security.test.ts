import { spawnSync } from 'node:child_process';
import type * as FileSystem from 'node:fs';
import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimProject, releaseProject } from '../src/claim.ts';

vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    linkSync: vi.fn(actual.linkSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

describe('claim filesystem security', () => {
  let root: string;
  const config = { baseUrl: 'https://example.invalid', projectId: 'claim-test' };
  function owners(): string {
    const user =
      readdirSync(root).find((name) => name.startsWith('upwind-deploy-claims-user-')) ?? '';
    const [project = ''] = readdirSync(path.join(root, user));
    return path.join(root, user, project, 'owners');
  }

  function interruptClaim(operation: 'openSync' | 'linkSync', app: string) {
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const [operation, source, app] = process.argv.slice(1);
      const original = fs[operation];
      fs[operation] = (...args) => {
        const result = original(...args);
        if (operation === 'linkSync' || args[1] === 'wx') process.exit(77);
        return result;
      };
      syncBuiltinESMExports();
      const { claimProject } = await import(source);
      claimProject({ baseUrl: 'https://example.invalid', projectId: 'claim-test' }, app);
    `;
    const claim = pathToFileURL(path.resolve(import.meta.dirname, '../src/claim.ts')).href;
    return spawnSync(
      process.execPath,
      ['--input-type=module', '-e', source, operation, claim, app],
      {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
      },
    );
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'upwind-claims-security-'));
    vi.spyOn(os, 'tmpdir').mockReturnValue(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  describe('private deployment claims', () => {
    it('closes and removes a new claim after a failed write so another fixture can recover', () => {
      const app = path.join(root, 'app');
      const other = path.join(root, 'other');
      mkdirSync(app);
      mkdirSync(other);
      const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      vi.mocked(writeFileSync).mockImplementationOnce(() => {
        throw failure;
      });
      const attempt = vi.fn(() => {
        claimProject(config, app);
      });

      expect(attempt).toThrow(failure);
      expect(attempt.mock.results[0]?.value).toBe(failure);
      expect(readdirSync(owners())).toStrictEqual([]);

      const pending = path.join(path.dirname(owners()), 'pending');

      expect(readdirSync(pending)).toStrictEqual([]);

      const closed = vi.mocked(closeSync).mock.invocationCallOrder.at(-1) ?? 0;
      const unlinked = vi.mocked(unlinkSync).mock.invocationCallOrder.at(-1) ?? 0;

      expect(closed).toBeLessThan(unlinked);
      expect(() => {
        claimProject(config, other);
      }).not.toThrow();
    });

    it('keeps a process exit after exclusive creation outside the published claims', () => {
      const app = path.join(root, 'app');
      const other = path.join(root, 'other');
      mkdirSync(app);
      mkdirSync(other);

      const result = interruptClaim('openSync', app);

      expect(result).toMatchObject({ status: 77 });
      expect(readdirSync(owners())).toStrictEqual([]);

      const pending = path.join(path.dirname(owners()), 'pending');
      const [name = ''] = readdirSync(pending);

      expect(readFileSync(path.join(pending, name), 'utf8')).toBe('');
      expect(() => {
        claimProject(config, other);
      }).not.toThrow();
    });

    it('keeps a complete claim readable after a process exits immediately after publication', () => {
      const app = path.join(root, 'app');
      const other = path.join(root, 'other');
      mkdirSync(app);
      mkdirSync(other);

      const result = interruptClaim('linkSync', app);
      const [name = ''] = readdirSync(owners());
      const entry = path.join(owners(), name);

      expect(result).toMatchObject({ status: 77 });
      expect(readFileSync(entry, 'utf8')).toBe(app);
      expect(lstatSync(entry).nlink).toBe(2);
      expect(() => {
        claimProject(config, app);
      }).not.toThrow();
      expect(() => {
        claimProject(config, other);
      }).toThrow('already deployed');

      rmSync(app, { recursive: true });

      expect(() => {
        claimProject(config, other);
      }).not.toThrow();
    });

    it('exposes only a complete claim to a contender during publication', async () => {
      const actual = await vi.importActual<typeof FileSystem>('node:fs');
      const app = path.join(root, 'app');
      const other = path.join(root, 'other');
      mkdirSync(app);
      mkdirSync(other);
      vi.mocked(linkSync).mockImplementationOnce((staged, entry) => {
        actual.linkSync(staged, entry);

        expect(readFileSync(entry, 'utf8')).toBe(app);
        expect(() => {
          claimProject(config, other);
        }).toThrow('already deployed');
      });

      claimProject(config, app);

      const dir = owners();
      const [name = ''] = readdirSync(dir);
      const entry = path.join(dir, name);
      const pending = path.join(path.dirname(dir), 'pending');

      expect(readFileSync(entry, 'utf8')).toBe(app);
      expect(readdirSync(pending)).toStrictEqual([]);
    });

    it('preserves publication errors and removes only its unpublished staging file', () => {
      const app = path.join(root, 'app');
      mkdirSync(app);
      const failure = Object.assign(new Error('no hard links available'), { code: 'EMLINK' });
      vi.mocked(linkSync).mockImplementationOnce(() => {
        throw failure;
      });
      const attempt = vi.fn(() => {
        claimProject(config, app);
      });

      expect(attempt).toThrow(failure);
      expect(attempt.mock.results[0]?.value).toBe(failure);
      expect(readdirSync(owners())).toStrictEqual([]);

      const pending = path.join(path.dirname(owners()), 'pending');

      expect(readdirSync(pending)).toStrictEqual([]);
      expect(() => {
        claimProject(config, app);
      }).not.toThrow();
    });

    it('keeps an empty legacy published claim occupied instead of deleting a live writer', () => {
      const app = path.join(root, 'app');
      const other = path.join(root, 'other');
      mkdirSync(app);
      mkdirSync(other);
      claimProject(config, app);
      const dir = owners();
      const [name = ''] = readdirSync(dir);
      const entry = path.join(dir, name);
      writeFileSync(entry, '');

      expect(() => {
        claimProject(config, other);
      }).toThrow('already deployed');
      expect(readFileSync(entry, 'utf8')).toBe('');
    });

    it('retains idempotent claims, rejects a competing fixture, and releases or expires claims', () => {
      const app = path.join(root, 'app');
      const other = path.join(root, 'other');
      mkdirSync(app);
      mkdirSync(other);
      claimProject(config, app);

      expect(() => {
        claimProject(config, app);
      }).not.toThrow();
      expect(() => {
        claimProject(config, other);
      }).toThrow('already deployed');

      releaseProject(config, app);
      claimProject(config, other);
      rmSync(other, { recursive: true });

      expect(() => {
        claimProject(config, app);
      }).not.toThrow();
    });

    it('refuses a planted own-claim symlink without changing its target', () => {
      const app = path.join(root, 'app');
      mkdirSync(app);
      claimProject(config, app);
      const dir = owners();
      const [name = ''] = readdirSync(dir);
      releaseProject(config, app);
      const victim = path.join(root, 'victim');
      writeFileSync(victim, 'untouched');
      symlinkSync(victim, path.join(dir, name));

      expect(() => {
        claimProject(config, app);
      }).toThrow('Unsafe deployment claim');
      expect(readFileSync(victim, 'utf8')).toBe('untouched');
    });

    it.skipIf(process.platform === 'win32')(
      'rejects insecure existing namespaces instead of repairing them',
      () => {
        const app = path.join(root, 'app');
        mkdirSync(app);
        claimProject(config, app);
        const dir = owners();
        chmodSync(dir, 0o755);

        expect(() => {
          claimProject(config, app);
        }).toThrow('Unsafe deployment claim directory');
      },
    );
  });
});
