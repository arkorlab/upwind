import { claimProject, releaseProject } from './claim.ts';
import { createClient } from './client.ts';
import { readConfig } from './config.ts';
import { deployFixture, preflight } from './deploy.ts';

/**
 * The commands the three hooks of Next.js's deploy-mode contract are made of.
 *
 *   node src/main.ts preflight              would a run get as far as its first deployment?
 *   node src/main.ts deploy [directory]     deploy the application here; print its URL
 *   node src/main.ts release [directory]    give the project back (the cleanup hook)
 *
 * The contract reserves standard output for the URL, so everything else this says goes to standard
 * error — including every failure, which the logs hook then shows beside the build's own output.
 */

const USAGE = 'usage: node src/main.ts <preflight|deploy|release> [directory]';
const COMMANDS = ['preflight', 'deploy', 'release'] as const;
type Command = (typeof COMMANDS)[number];

function say(message: string): void {
  console.error(message);
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
      return;
    }
    case 'release': {
      releaseProject(config, appDir);
    }
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  say(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
