import path from 'node:path';

import type { NextAdapter } from 'next';

import { orDefault } from './collect.ts';

type ModifyConfig = NonNullable<NextAdapter['modifyConfig']>;

/**
 * The project's directory, which `modifyConfig` is told from 16.3.
 *
 * 16.2 tells the hook its phase and its version, and no directory. What it does hand over is the
 * config file it read (`configFile`), which it found by looking from the project's directory up:
 * the project's own, or an ancestor's where the project has none. So the working directory is the
 * answer where it is inside that file's directory — `upwind build` and a bare `next build` both run
 * from the project — and the file's directory is the answer where it is not, which is a build
 * pointed at a project elsewhere: `next build apps/site` from the root of a repository. With no
 * config file at all, the working directory is all there is. What this still answers wrongly is a
 * 16.2 build pointed elsewhere at a project with no config of its own; every release from 16.3
 * says.
 */
export function projectDirOf(
  config: Parameters<ModifyConfig>[0],
  context: Parameters<ModifyConfig>[1],
): string {
  const told = orDefault<string | undefined>(context.projectDir, undefined);
  if (told !== undefined) {
    return told;
  }
  const cwd = process.cwd();
  if (config.configFile === undefined) {
    return cwd;
  }
  const configDir = path.dirname(config.configFile);
  const fromConfig = path.relative(configDir, cwd);
  const runsInside =
    fromConfig !== '..' && !fromConfig.startsWith(`..${path.sep}`) && !path.isAbsolute(fromConfig);
  return runsInside ? cwd : configDir;
}
