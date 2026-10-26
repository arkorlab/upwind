import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { refreshAgentRules, writeAgentRules } from '../src/agents.ts';
import { directoryCommand } from '../src/create.ts';

async function nextPackage(root: string, marker: string): Promise<void> {
  const helperDir = path.join(root, 'dist/server/lib');
  await mkdir(helperDir, { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'next', type: 'commonjs' }),
  );
  await writeFile(
    path.join(helperDir, 'generate-agent-files.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'imported'); exports.writeAgentFiles = () => {};`,
  );
}

async function installMapping(target: string, marker: string, linked: boolean): Promise<void> {
  await mkdir(path.join(target, 'node_modules'), { recursive: true });
  const mapping = path.join(target, 'node_modules/next');
  if (linked) {
    const installed = path.join(target, '../store/next');
    await nextPackage(installed, marker);
    await symlink(installed, mapping, 'dir');
  } else await nextPackage(mapping, marker);
}

describe('scaffolder security', () => {
  const directories: string[] = [];
  async function directory(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'upwind-scaffold-security-'));
    directories.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  describe('scaffold agent helper provenance', () => {
    it.each([false, true])(
      'loads the explicit dependency mapping (symlink: %s)',
      async (linked) => {
        const base = await directory();
        const target = path.join(base, 'app');
        const marker = path.join(base, 'marker');
        await installMapping(target, marker, linked);

        await expect(refreshAgentRules(target)).resolves.toBe(true);
        await expect(readFile(marker, 'utf8')).resolves.toBe('imported');
      },
    );

    it('keeps static rules without importing a planted ancestor package', async () => {
      const base = await directory();
      const target = path.join(base, 'app');
      const marker = path.join(base, 'marker');
      await mkdir(target);
      await writeAgentRules(target);
      await writeFile(path.join(target, '.pnp.cjs'), 'module.exports = {};');
      await nextPackage(path.join(base, 'node_modules/next'), marker);
      const original = await readFile(path.join(target, 'AGENTS.md'), 'utf8');

      await expect(refreshAgentRules(target)).resolves.toBe(false);
      await expect(readFile(path.join(target, 'AGENTS.md'), 'utf8')).resolves.toBe(original);
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not import a helper symlink that escapes the selected Next package', async () => {
      const base = await directory();
      const target = path.join(base, 'app');
      const marker = path.join(base, 'marker');
      const mapping = path.join(target, 'node_modules/next');
      await nextPackage(mapping, marker);
      const helper = path.join(mapping, 'dist/server/lib/generate-agent-files.js');
      const outside = path.join(base, 'outside.cjs');
      await writeFile(outside, await readFile(helper));
      await rm(helper);
      await symlink(outside, helper);

      await expect(refreshAgentRules(target)).resolves.toBe(false);
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('displayed directory command', () => {
    it('quotes PowerShell expansion, wildcards, drives, and every single-quote delimiter literally', () => {
      const value = String.raw`D:\$(Write-Output owned)\a[b] %HOME% '‘’‚‛`;

      expect(directoryCommand(value, 'win32')).toBe(
        String.raw`Set-Location -LiteralPath 'D:\$(Write-Output owned)\a[b] %HOME% ''‘‘’’‚‚‛‛'`,
      );
      expect(directoryCommand('-folder', 'win32')).toBe("Set-Location -LiteralPath '-folder'");
    });

    it('retains POSIX quoting and protects leading dashes', () => {
      expect(directoryCommand('-folder', 'linux')).toBe('cd ./-folder');
      expect(directoryCommand("a'b $(echo x)", 'linux')).toBe(String.raw`cd 'a'\''b $(echo x)'`);
    });
  });
});
