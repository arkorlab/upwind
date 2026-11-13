import { fork } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REFRESH_EARLY_MS = 300_000;
const AUTHENTICATION_ENV =
  /^(?:AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN|WEB_IDENTITY_TOKEN_FILE|SHARED_CREDENTIALS_FILE|CONFIG_FILE|CONTAINER_CREDENTIALS_.*|CONTAINER_AUTHORIZATION_.*|LOGIN_CACHE_DIRECTORY)|AMAZON_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN))$/iu;

/** Credential values and private file locations are removed before evaluating project code. */
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
    if (AUTHENTICATION_ENV.test(name)) Reflect.deleteProperty(env, name);
  }
  return { env: snapshot };
}

/** Validate the private helper protocol before using any credentials or refresh timestamp. */
export function credentialIdentity(value: unknown): Identity {
  if (typeof value !== 'object' || value === null)
    throw new Error('invalid AWS credential helper response');
  const fields = value as Record<string, unknown>;
  if (
    typeof fields['accessKeyId'] !== 'string' ||
    fields['accessKeyId'] === '' ||
    typeof fields['secretAccessKey'] !== 'string' ||
    fields['secretAccessKey'] === '' ||
    (fields['sessionToken'] !== undefined && typeof fields['sessionToken'] !== 'string') ||
    (fields['expiration'] !== undefined &&
      (typeof fields['expiration'] !== 'string' ||
        !Number.isFinite(Date.parse(fields['expiration']))))
  )
    throw new Error('invalid AWS credential helper identity');
  return {
    accessKeyId: fields['accessKeyId'],
    secretAccessKey: fields['secretAccessKey'],
    ...(fields['sessionToken'] === undefined ? {} : { sessionToken: fields['sessionToken'] }),
    ...(fields['expiration'] === undefined
      ? {}
      : { expiration: new Date(fields['expiration'] as string) }),
  };
}

async function resolveIdentity(environment: NodeJS.ProcessEnv): Promise<Identity> {
  const worker = await workerFile();
  return new Promise((resolve, reject) => {
    // IPC remains separate from stdout emitted by a user's NODE_OPTIONS preload module.
    const child = fork(worker, [], {
      env: environment,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    let reply: unknown;
    let timedOut = false;
    let forced: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forced = setTimeout(() => {
        child.kill('SIGKILL');
      }, 1000);
      forced.unref();
    }, 120_000);
    child.on('message', (value: unknown) => {
      reply = value;
    });
    child.once('error', () => {
      clearTimeout(timer);
      if (forced !== undefined) clearTimeout(forced);
      reject(new Error('AWS credential helper could not start'));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (forced !== undefined) clearTimeout(forced);
      const fields =
        typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>) : {};
      if (timedOut || code !== 0) {
        const kind =
          typeof fields['error'] === 'string' && /^[\w.-]{1,80}$/u.test(fields['error'])
            ? fields['error']
            : 'credential chain failed';
        reject(
          new Error(
            `AWS credentials could not be resolved (${timedOut ? 'helper timed out after 120s' : `${kind}; ${signal ?? `exit ${String(code)}`}`}); configure an AWS profile, SSO, OIDC, or a task role`,
          ),
        );
        return;
      }
      try {
        resolve(credentialIdentity(fields['identity']));
      } catch (error) {
        reject(error);
      }
    });
  });
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
    const identity = await resolveIdentity(environment);
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
