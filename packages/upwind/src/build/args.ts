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
 *
 * `--help` and `--version` are options here rather than tokens looked for in the arguments, for the
 * reason `args.ts` gives of `upwind dev`: it is the parser that knows where the options end, and a
 * directory named `--help` is named after a `--`.
 */

export interface BuildOptions {
  /** The application's directory: what `next build [dir]` would have been given. */
  readonly projectDir: string;
}

/** What `upwind build` was asked for: an answer about itself, or a build of this directory. */
export type BuildRequest =
  | { readonly answer: 'help' | 'version' }
  | { readonly answer: undefined; readonly options: BuildOptions };

function answerOf(values: {
  readonly help?: boolean;
  readonly version?: boolean;
}): BuildRequest['answer'] {
  if (values.help === true) {
    return 'help';
  }
  return values.version === true ? 'version' : undefined;
}

export function parseBuildRequest(args: readonly string[]): BuildRequest {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
    strict: true,
  });
  const answer = answerOf(values);
  if (answer !== undefined) {
    return { answer };
  }
  if (positionals.length > 1) {
    throw new Error(
      `\`upwind build\` takes at most one directory, and was given ${positionals.length}`,
    );
  }
  return { answer: undefined, options: { projectDir: path.resolve(positionals[0] ?? '.') } };
}
