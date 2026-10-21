import path from 'node:path';
import { parseArgs } from 'node:util';

/**
 * What `upwind deploy` understands.
 *
 * A directory, and how much of a deploy to do: build and deploy (the default), build only
 * (`--build-only`, for a job that holds no credentials), deploy what a build left (`--prebuilt`,
 * for the job that does), or plan without changing anything (`--dry-run`). Secrets come from the
 * environment and from each `--env-file`; the account and its token from the environment alone,
 * never from a flag, which a shell's history would keep.
 *
 * Strict, like the other commands' parsers: a flag this does not implement is an error rather than
 * a deploy that ignored it.
 */

export interface DeployOptions {
  readonly projectDir: string;
  /** Deploy the bundle a build already left, without building. */
  readonly prebuilt: boolean;
  /** Build for a deploy, and stop. */
  readonly buildOnly: boolean;
  /** Files of secrets, in the order given; a later one wins. */
  readonly envFiles: readonly string[];
  /** `deploy.keep`, for this run. */
  readonly keep: number | undefined;
  /** What the deployment is noted as, beside its id. */
  readonly message: string | undefined;
  /** Say what would be done, and change nothing. */
  readonly dryRun: boolean;
}

export type DeployRequest =
  | { readonly answer: 'help' | 'version' }
  | { readonly answer: undefined; readonly options: DeployOptions };

const MAX_KEEP = 50;
/** What a version's message keeps of one; Cloudflare cuts at 1000 bytes. */
const MAX_MESSAGE = 200;

function keepOf(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const keep = Number(raw);
  if (!/^\d+$/u.test(raw) || keep > MAX_KEEP) {
    throw new Error(`--keep takes a whole number from 0 to ${MAX_KEEP}, and was given ${raw}`);
  }
  return keep;
}

export function parseDeployRequest(args: readonly string[]): DeployRequest {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      prebuilt: { type: 'boolean' },
      'build-only': { type: 'boolean' },
      'env-file': { type: 'string', multiple: true },
      keep: { type: 'string' },
      message: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) {
    return { answer: 'help' };
  }
  if (values.version === true) {
    return { answer: 'version' };
  }
  if (positionals.length > 1) {
    throw new Error(
      `\`upwind deploy\` takes at most one directory, and was given ${positionals.length}`,
    );
  }
  const prebuilt = values.prebuilt === true;
  const buildOnly = values['build-only'] === true;
  if (prebuilt && buildOnly) {
    throw new Error('--prebuilt deploys a build and --build-only stops before deploying; give one');
  }
  const message = values.message;
  if (message !== undefined && message.length > MAX_MESSAGE) {
    throw new Error(`--message is ${message.length} characters, over the ${MAX_MESSAGE} kept`);
  }
  const projectDir = path.resolve(positionals[0] ?? '.');
  return {
    answer: undefined,
    options: {
      projectDir,
      prebuilt,
      buildOnly,
      envFiles: (values['env-file'] ?? []).map((file) => path.resolve(file)),
      keep: keepOf(values.keep),
      message,
      dryRun: values['dry-run'] === true,
    },
  };
}
