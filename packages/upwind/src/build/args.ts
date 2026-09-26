import path from 'node:path';
import { parseArgs } from 'node:util';

/**
 * What `upwind build` understands: a directory, and nothing else.
 *
 * `next build`'s own flags — `--debug`, `--profile`, `--no-lint` — are not forwarded. They are not
 * quietly accepted either: `parseArgs` in strict mode refuses what this does not implement, so a flag
 * that would have changed a build is an error rather than a build that ignored it. A project that
 * needs one runs `next build` itself; the `next.config` a scaffolded project has names the adapter,
 * so that build produces the same bundle this one does.
 */

export interface BuildOptions {
  /** The application's directory: what `next build [dir]` would have been given. */
  readonly projectDir: string;
}

export function parseBuildOptions(args: readonly string[]): BuildOptions {
  const { positionals } = parseArgs({
    args: [...args],
    options: {},
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 1) {
    throw new Error(
      `\`upwind build\` takes at most one directory, and was given ${positionals.length}`,
    );
  }
  return { projectDir: path.resolve(positionals[0] ?? '.') };
}
