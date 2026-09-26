import { parseArgs } from 'node:util';

import { PACKAGE_MANAGERS, type PackageManager } from './package-manager.ts';

/**
 * What `create-upwind` understands.
 *
 * A directory, and three things about what to do after writing it. Everything a scaffolder usually
 * asks about the application itself — the language, the router, the bundler — is decided by what
 * upwind runs, so there is nothing to ask and nothing to flag.
 */

export interface CreateRequest {
  /** Where the application goes; nothing when it is still to be asked for. */
  readonly directory: string | undefined;
  readonly install: boolean;
  readonly git: boolean;
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

export function parseCreateRequest(args: readonly string[]): CreateRequest {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      git: { type: 'boolean', default: true },
      'skip-install': { type: 'boolean' },
      'use-bun': { type: 'boolean' },
      'use-npm': { type: 'boolean' },
      'use-pnpm': { type: 'boolean' },
      'use-yarn': { type: 'boolean' },
    },
    allowNegative: true,
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 1) {
    throw new Error(`one directory at most, and ${positionals.length} were given`);
  }
  return {
    directory: positionals[0],
    install: values['skip-install'] !== true,
    git: values.git,
    packageManager: packageManagerOf(values),
  };
}
