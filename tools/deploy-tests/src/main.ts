import { claimProject, releaseProject } from './claim.ts';
import { createClient } from './client.ts';
import { readConfig, readProjectConfig } from './config.ts';
import { deployFixture, preflight } from './deploy.ts';

/**
 * The commands the three hooks of Next.js's deploy-mode contract are made of.
 *
 *   node src/main.ts preflight              would a run get as far as its first deployment?
 *   node src/main.ts deploy [directory]     deploy the application here; print its URL
 *   node src/main.ts release [directory]    give the project back (the cleanup hook)
 *
 * The contract reserves standard output for the URL, so everything else this says goes to standard
 * error — including every failure. The deploy hook passes it on to the suite's log as it happens, which
 * is the one place a failure is sure to be read: the logs hook is not called when setup itself failed.
 */

const USAGE = 'usage: node src/main.ts <preflight|deploy|release> [directory]';
/** How far down a `cause` chain a failure is followed. */
const MAX_CAUSES = 5;
const COMMANDS = ['preflight', 'deploy', 'release'] as const;
type Command = (typeof COMMANDS)[number];

function say(message: string): void {
  console.error(message);
}

/**
 * A failure with what caused it under it.
 *
 * Nothing here is read as it happens: the suite's harness shows this hours later through the logs
 * hook, so a message that dropped the `cause` would be a message nobody can act on — and the causes
 * are the interesting half (a child process's output, a refusal's code and status).
 */
function reported(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const said = [error.message];
  // Bounded, because a chain that points back at itself is a tool that never finishes saying why it
  // failed. Nothing here builds one; nothing here has to be the thing that proves it.
  for (let cause: unknown = error.cause; cause !== undefined && said.length <= MAX_CAUSES;) {
    if (cause instanceof Error) {
      said.push(cause.message);
      cause = cause.cause;
      continue;
    }
    // Whatever it is, it is not an `Error` and not this tool's: shown as JSON rather than as
    // `[object Object]`, which is what stringifying it would otherwise say.
    said.push(typeof cause === 'string' ? cause : JSON.stringify(cause));
    cause = undefined;
  }
  return said.join('\n  caused by: ');
}

function commandOf(value: string | undefined): Command {
  // Asked before the configuration is read, so that a typo is answered with the usage rather than with
  // the first variable that happens to be missing.
  if (value === undefined || !COMMANDS.includes(value as Command)) {
    throw new Error(USAGE);
  }
  return value as Command;
}

async function main(argv: readonly string[]): Promise<void> {
  const [first, directory] = argv;
  const command = commandOf(first);
  const appDir = directory ?? process.cwd();
  if (command === 'release') {
    // No token asked for: giving the project back is a file on this machine, and a cleanup hook that
    // demanded a credential would fail on a run whose credential is already gone.
    releaseProject(readProjectConfig(), appDir);
    return;
  }
  const config = readConfig();
  const client = createClient(config);
  switch (command) {
    case 'preflight': {
      await preflight({ client, config, log: say });
      return;
    }
    case 'deploy': {
      claimProject(config, appDir);
      try {
        const deployment = await deployFixture({ appDir, client, config, log: say });
        // The one thing on standard output: the harness reads it as the deployment's URL.
        process.stdout.write(`${deployment.url}\n`);
      } catch (error) {
        // The tests never run, so the cleanup hook the harness would have called is not coming.
        releaseProject(config, appDir);
        throw error;
      }
    }
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  say(reported(error));
  process.exitCode = 1;
}
