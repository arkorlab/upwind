import { parseArgs } from 'node:util';

import { PACKAGE_MANAGERS, type PackageManager } from './package-manager.ts';

/**
 * What `create-upwind` understands.
 *
 * A directory, and four things about what is written with it. Everything a scaffolder usually
 * asks about the application itself — the language, the router, the bundler — is decided by what
 * upwind runs, so there is nothing to ask and nothing to flag.
 *
 * `--no-agents-md` is the one exception, and it is `create-next-app`'s: what an agent is told
 * about this Next.js is not a fact about the application, and a project that keeps its agent rules
 * somewhere else has nothing to gain from one more file.
 */

export interface CreateRequest {
  /** What was asked for instead of an application, if anything. */
  readonly answer: 'help' | 'version' | undefined;
  /** Where the application goes; nothing when it is still to be asked for. */
  readonly directory: string | undefined;
  readonly install: boolean;
  readonly git: boolean;
  /** Write `AGENTS.md`, as `create-next-app` does unless told not to. */
  readonly agentsMd: boolean;
  /** The manager to install with, or nothing to use the one this was started from. */
  readonly packageManager: PackageManager | undefined;
}

/** At most one `--use-*`: two would be a question about which, and there is no good answer. */
function packageManagerOf(values: Readonly<Record<string, unknown>>): PackageManager | undefined {
  const chosen = PACKAGE_MANAGERS.filter((manager) => values[`use-${manager}`] === true);
  if (chosen.length > 1) {
    throw new Error(`only one package manager can be asked for, and ${chosen.length} were`);
  }
  return chosen[0];
}

/** `--help` and `--version` are options here rather than words looked for in the arguments, so that
 * `create-upwind -- --help` makes a directory called `--help` the way `parseArgs` says it should. */
function answerOf(values: Readonly<Record<string, unknown>>): CreateRequest['answer'] {
  if (values['help'] === true) {
    return 'help';
  }
  return values['version'] === true ? 'version' : undefined;
}

export function parseCreateRequest(args: readonly string[]): CreateRequest {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      'agents-md': { type: 'boolean', default: true },
      git: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h' },
      'skip-install': { type: 'boolean' },
      'use-bun': { type: 'boolean' },
      'use-npm': { type: 'boolean' },
      'use-pnpm': { type: 'boolean' },
      'use-yarn': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
    },
    allowNegative: true,
    allowPositionals: true,
    strict: true,
  });
  const answer = answerOf(values);
  if (answer === undefined && positionals.length > 1) {
    throw new Error(`one directory at most, and ${positionals.length} were given`);
  }
  return {
    answer,
    directory: positionals[0],
    install: values['skip-install'] !== true,
    git: values.git,
    agentsMd: values['agents-md'],
    packageManager: answer === undefined ? packageManagerOf(values) : undefined,
  };
}
