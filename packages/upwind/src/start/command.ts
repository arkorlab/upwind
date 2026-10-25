import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';

import type { StartOptions } from './args.ts';
import { startEnvironment } from './environment.ts';

/** The CLI starts a built server in its own process; application globals stay in that process. */
export async function runStart(options: StartOptions): Promise<number> {
  const root = path.join(options.projectDir, '.arkor/node');
  let manifest: { readonly format?: unknown; readonly v?: unknown };
  try {
    manifest = JSON.parse(
      await readFile(path.join(root, 'manifest.json'), 'utf8'),
    ) as typeof manifest;
  } catch {
    throw new Error('no native artifact was found; run `upwind build --target=node` first');
  }
  if (manifest.format !== 'upwind-node' || manifest.v !== 1)
    throw new Error('unsupported native artifact format');
  const fromFiles: Record<string, string> = {};
  for (const file of options.envFiles)
    Object.assign(fromFiles, parseEnv(await readFile(file, 'utf8')));
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: options.projectDir,
    stdio: 'inherit',
    env: startEnvironment(options, fromFiles),
  });
  const interrupt = (): void => {
    child.kill('SIGINT');
  };
  const terminate = (): void => {
    child.kill('SIGTERM');
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    await once(child, 'exit');
    return child.exitCode ?? 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
