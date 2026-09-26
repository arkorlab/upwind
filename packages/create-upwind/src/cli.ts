#!/usr/bin/env node
import { parseCreateRequest } from './args.ts';
import { create } from './create.ts';
import { ownVersion } from './version.ts';

/**
 * `create-upwind` — one command, one template, one question.
 *
 * `pnpm create upwind` (and `npm create upwind`, and the others) reach this program, and it writes a
 * Next.js application that upwind can run: Next.js and React as real dependencies, because upwind
 * runs the *project's* Next.js and has none of its own, the adapter that turns a build into a
 * deployment bundle, and Tailwind, because an application with no way to style it is a demonstration
 * rather than a start.
 */

const USAGE = `create-upwind — a Next.js application wired to upwind

Usage
  pnpm create upwind [directory]

Options
      --skip-install  Write the application, install nothing
      --no-git        Do not make a first commit
      --use-npm       Install with npm
      --use-pnpm      Install with pnpm
      --use-yarn      Install with yarn
      --use-bun       Install with bun
  -v, --version       Print create-upwind's version
  -h, --help          Print this

Asked for no directory, it asks for one — or takes \`my-upwind-app\` when nothing is there to ask.
`;

function fail(message: string, withUsage: boolean): never {
  console.error(`create-upwind: ${message}`);
  if (withUsage) {
    console.error(`\n${USAGE}`);
  }
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log((await ownVersion()) ?? 'unknown');
    return;
  }
  let request;
  try {
    request = parseCreateRequest(argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), true);
  }
  await create(request);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? `create-upwind: ${error.message}` : error);
  process.exitCode = 1;
}
