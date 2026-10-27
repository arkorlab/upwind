import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { errorAnnotation, plainDiagnostic } from '../src/annotate.ts';
import { boundedFile, MAX_FILE_BYTES } from '../src/read.ts';
import { hitsOfFile } from '../src/scan.ts';

describe('vocabulary security', () => {
  const directories: string[] = [];
  function directory(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'upwind-vocabulary-security-'));
    directories.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  describe('bounded repository reads', () => {
    it('reads an ordinary file at the bound and rejects per-file and cumulative overflow', () => {
      const root = directory();
      writeFileSync(path.join(root, 'source'), Buffer.alloc(MAX_FILE_BYTES, 0x61));

      expect(boundedFile(root, 'source')).toHaveLength(MAX_FILE_BYTES);
      expect(() => boundedFile(root, 'source', MAX_FILE_BYTES - 1)).toThrow('byte budget');

      writeFileSync(path.join(root, 'large'), Buffer.alloc(MAX_FILE_BYTES + 1));

      expect(() => boundedFile(root, 'large')).toThrow('byte budget');
    });

    it('refuses symlinks, directories, and a parent that escapes the repository', () => {
      const root = directory();
      const outside = directory();
      writeFileSync(path.join(outside, 'file'), 'private');
      symlinkSync(path.join(outside, 'file'), path.join(root, 'link'));
      symlinkSync(outside, path.join(root, 'parent'), 'dir');
      mkdirSync(path.join(root, 'dir'));

      expect(() => boundedFile(root, 'link')).toThrow('regular file');
      expect(() => boundedFile(root, 'dir')).toThrow('regular file');
      expect(() => boundedFile(root, 'parent/file')).toThrow('outside the repository');
    });

    it.skipIf(process.platform === 'win32')('refuses a FIFO before trying to read it', () => {
      const root = directory();
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- mkfifo creates only this test's private FIFO.
      execFileSync('mkfifo', [path.join(root, 'pipe')]);

      expect(() => boundedFile(root, 'pipe')).toThrow('regular file');
    });
  });

  it('keeps exact locations across sparse lines and repeated hits', () => {
    const text = `billing\n${'\n'.repeat(1000)}  billing billing\n`;

    expect(hitsOfFile('source', text).map(({ line, column }) => ({ line, column }))).toStrictEqual([
      { line: 1, column: 1 },
      { line: 1002, column: 3 },
      { line: 1002, column: 11 },
    ]);
  });

  it('keeps hostile filenames and errors within one diagnostic line', () => {
    const message = 'a\n::warning::forged\r\u{1B}[31m%';

    expect(plainDiagnostic(message)).toBe(String.raw`a\n::warning::forged\r\u001b[31m%`);
    expect(errorAnnotation(message)).toBe(
      '::error title=vocabulary::a%0A::warning::forged%0D\u{1B}[31m%25',
    );
  });
});
