import {
  chmodSync,
  closeSync,
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimProject, releaseProject } from '../src/claim.ts';

vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
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

      const closed = vi.mocked(closeSync).mock.invocationCallOrder.at(-1) ?? 0;
      const unlinked = vi.mocked(unlinkSync).mock.invocationCallOrder.at(-1) ?? 0;

      expect(closed).toBeLessThan(unlinked);
      expect(() => {
        claimProject(config, other);
      }).not.toThrow();
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
