import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const REFRESH_EARLY_MS = 300_000;

/** A private snapshot, never restored to the process evaluating the project's configuration. */
export interface AwsCredentials {
  readonly env: Readonly<Record<string, string | undefined>>;
}

interface Identity {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
  readonly expiration?: Date | undefined;
}

export function takeAwsCredentials(
  env: Record<string, string | undefined> = process.env,
): AwsCredentials {
  const snapshot = { ...env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('AWS_') || name.startsWith('AMAZON_')) Reflect.deleteProperty(env, name);
  }
  return { env: snapshot };
}

/** AWS variables may be application credentials on another provider; preserve that existing use. */
export function restoreAwsApplicationEnvironment(
  snapshot: AwsCredentials,
  env: Record<string, string | undefined> = process.env,
): void {
  for (const [name, value] of Object.entries(snapshot.env)) {
    if ((name.startsWith('AWS_') || name.startsWith('AMAZON_')) && value !== undefined)
      env[name] = value;
  }
}

async function workerFile(): Promise<string> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as {
        readonly name?: string;
      };
      if (manifest.name === 'upwind') {
        const compiled = path.join(directory, 'dist/aws-credentials.js');
        try {
          await access(compiled);
          return compiled;
        } catch {
          return path.join(directory, 'src/aws/credential-worker.ts');
        }
      }
    } catch {
      // Continue to the package that owns this module.
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('cannot locate the AWS credential helper');
    directory = parent;
  }
}

/** Use the standard SDK chain in an isolated process, without exposing its environment to the app. */
export function awsCredentialProvider(snapshot?: AwsCredentials): () => Promise<Identity> {
  const environment = { ...(snapshot?.env ?? process.env) };
  let cached: Identity | undefined;
  let pending: Promise<Identity> | undefined;
  const resolve = async (): Promise<Identity> => {
    const { stdout } = await execute(process.execPath, [await workerFile()], {
      env: environment,
      maxBuffer: 65_536,
      timeout: 120_000,
      windowsHide: true,
    }).catch(() => {
      throw new Error(
        'AWS credentials could not be resolved; configure an AWS profile, SSO, OIDC, or a task role',
      );
    });
    const value = JSON.parse(stdout) as {
      readonly accessKeyId?: unknown;
      readonly secretAccessKey?: unknown;
      readonly sessionToken?: string;
      readonly expiration?: string;
    };
    if (typeof value.accessKeyId !== 'string' || typeof value.secretAccessKey !== 'string') {
      throw new Error('the AWS credential helper returned no credentials');
    }
    const identity: Identity = {
      accessKeyId: value.accessKeyId,
      secretAccessKey: value.secretAccessKey,
      ...(value.sessionToken === undefined ? {} : { sessionToken: value.sessionToken }),
      ...(value.expiration === undefined ? {} : { expiration: new Date(value.expiration) }),
    };
    cached = identity;
    return identity;
  };
  return async () => {
    if (
      cached !== undefined &&
      (cached.expiration === undefined ||
        cached.expiration.getTime() > Date.now() + REFRESH_EARLY_MS)
    )
      return cached;
    pending ??= resolve().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
