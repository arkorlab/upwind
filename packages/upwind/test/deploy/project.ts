import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A project with an adapter of its own installed: one whose reader returns what the test says, so
 * that what is tested is how a deploy fills in its settings and whose reader it trusts — the reader
 * itself is the adapter's, and tested there.
 */
export function projectWith(input: {
  readonly packageName?: string;
  readonly adapterVersion: string | undefined;
  readonly config?: unknown;
  readonly exportsReader?: boolean;
  /** Where the project is; a directory of its own when absent. */
  readonly dir?: string;
}): string {
  const dir = input.dir ?? mkdtempSync(path.join(tmpdir(), 'upwind-deploy-config-'));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: input.packageName ?? 'my-shop', private: true }),
  );
  const adapter = path.join(dir, 'node_modules', '@stayingupwind', 'adapter');
  mkdirSync(adapter, { recursive: true });
  writeFileSync(
    path.join(adapter, 'package.json'),
    JSON.stringify({
      name: '@stayingupwind/adapter',
      version: input.adapterVersion,
      type: 'module',
      exports: { '.': './index.js' },
    }),
  );
  const config = JSON.stringify(input.config ?? { file: undefined, crons: [] });
  writeFileSync(
    path.join(adapter, 'index.js'),
    input.exportsReader === false
      ? 'export default {};'
      : `export async function readProjectConfig() { return ${config}; }`,
  );
  return dir;
}
