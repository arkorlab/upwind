import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

import {
  RESOURCE_CHANGES_SERVICE_BINDING,
  RESOURCES_MANIFEST_BINDING,
} from '@stayingupwind/core/paas';
import {
  CACHE_GATEWAY_URL_BINDING,
  CACHE_READ_GATEWAY_URL_BINDING,
  CACHE_READ_SERVICE_BINDING,
  CACHE_SERVICE_BINDING,
  CACHE_TOKEN_BINDING,
  DEPLOYMENT_ID_BINDING,
  PREFETCH_SERVICE_BINDING,
  RESPONSE_CACHE_TTL_BINDING,
  RUNTIME_BINDING,
} from '@stayingupwind/host/bindings';

import { isCredentialVariable } from './credentials.ts';

/**
 * The secrets a deployment's Functions are given, read afresh on every deploy.
 *
 * A deployment's Functions are new Workers each time (`names.ts`), so nothing set on an earlier
 * one carries over: every secret is uploaded with every Function, from what this run was given.
 * Two places give them, and both are the deploy's own environment rather than the project's code:
 *
 * - each `--env-file`, every variable in it, a later file's value of a name winning;
 * - each name `deploy.secrets` lists, read from this process's environment — the way a CI job
 *   holds one — and winning over a file.
 *
 * A listed name found in neither is refused rather than deployed without: the Function would run
 * and fail on the first request that read it. So is a name the host gives a Function itself, a
 * storage binding's name, and a Cloudflare credential, which is never this deploy's to hand on.
 */

/** What Cloudflare holds one variable of a Worker to: five kibibytes. */
export const MAX_VARIABLE_BYTES = 5120;

/**
 * Every name the host's contract gives a Function's environment, whether or not this deploy binds
 * it: the runtime reads each as the host's own, so an application's secret of one of these names
 * would be read as something it is not — as `@stayingupwind/local` refuses to hand one on too.
 */
const HOST_NAMES: readonly string[] = [
  CACHE_SERVICE_BINDING,
  CACHE_READ_SERVICE_BINDING,
  CACHE_GATEWAY_URL_BINDING,
  CACHE_READ_GATEWAY_URL_BINDING,
  CACHE_TOKEN_BINDING,
  RESPONSE_CACHE_TTL_BINDING,
  DEPLOYMENT_ID_BINDING,
  RUNTIME_BINDING,
  PREFETCH_SERVICE_BINDING,
  RESOURCE_CHANGES_SERVICE_BINDING,
  RESOURCES_MANIFEST_BINDING,
];

/** Whether every Function is given a binding of that name by the host. */
export function isHostBound(name: string): boolean {
  return HOST_NAMES.includes(name);
}

/** The names a secret may not have: the host's, and the storage bindings the project asked for. */
export function reservedNames(storage: readonly { readonly name: string }[]): ReadonlySet<string> {
  const names = new Set(HOST_NAMES);
  for (const binding of storage) {
    names.add(binding.name);
  }
  return names;
}

/** A variable's name as an environment carries it and a Worker's bindings take it. */
const VARIABLE_NAME = /^[A-Za-z_]\w{0,127}$/u;

/** A line that declares `__proto__`, which `parseEnv` drops rather than keeps. */
const PROTO_LINE = /^[\t ]*(?:export[\t ]+)?__proto__[\t ]*=/mu;

export interface SecretInput {
  /** `--env-file`, in the order given. */
  readonly files: readonly string[];
  /** `deploy.secrets`: names read from `env`. */
  readonly names: readonly string[];
  /** This process's environment, after the credentials were taken out of it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Names the host binds for itself, and the storage bindings the project asked for. */
  readonly reserved: ReadonlySet<string>;
}

/** Every variable the files hold, a later file's value of a name winning. */
async function fromFiles(files: readonly string[]): Promise<Map<string, string>> {
  const secrets = new Map<string, string>();
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (PROTO_LINE.test(text)) {
      throw new Error(`${file} declares \`__proto__\`, which no Worker binding can be called`);
    }
    const parsed = Object.entries(parseEnv(text));
    for (const [name, value] of parsed) {
      if (value !== undefined) {
        secrets.set(name, value);
      }
    }
  }
  return secrets;
}

/** Each name `deploy.secrets` lists, from the environment over the files; refused where neither sets it. */
function withNamed(
  secrets: Map<string, string>,
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): void {
  const missing: string[] = [];
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) {
      secrets.set(name, value);
    } else if (!secrets.has(name)) {
      missing.push(name);
    }
  }
  if (missing.length === 0) {
    return;
  }
  const them = missing.length === 1 ? 'it' : 'them';
  throw new Error(
    `deploy.secrets names ${missing.join(', ')}, which neither the environment nor an --env-file sets; a Function deployed without ${them} would fail on the first request that read ${them}`,
  );
}

/** Why a secret of this name and value cannot be given to a Function; nothing when it can. */
function refusalOf(name: string, value: string, reserved: ReadonlySet<string>): string | undefined {
  if (!VARIABLE_NAME.test(name)) {
    return `${name} is not a name a Worker's variable can have`;
  }
  if (isCredentialVariable(name)) {
    return `${name} is a Cloudflare credential, and a deploy never hands one to a Function — rename it if the application needs it`;
  }
  if (reserved.has(name)) {
    return `${name} is a name the deployment binds for itself, so a secret cannot be called that`;
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_VARIABLE_BYTES) {
    return `${name} is over the ${MAX_VARIABLE_BYTES} bytes a Worker's variable may hold`;
  }
  return undefined;
}

/** Every secret by name, in the order the names were first seen. */
export async function readSecrets(input: SecretInput): Promise<ReadonlyMap<string, string>> {
  const secrets = await fromFiles(input.files);
  withNamed(secrets, input.names, input.env);
  for (const [name, value] of secrets) {
    const refusal = refusalOf(name, value, input.reserved);
    if (refusal !== undefined) {
      throw new Error(refusal);
    }
  }
  return secrets;
}

/**
 * One secret, as `readSecrets` reads it among the rest — from the environment where
 * `deploy.secrets` names it, else from the last `--env-file` that sets it — with that one alone held
 * to what a variable may be: for a command that sends that secret and binds nothing else of the
 * files, which their other variables, valid as a Function's or not, are no reason to refuse.
 */
export async function readSecret(
  input: SecretInput & { readonly name: string },
): Promise<string | undefined> {
  const { name } = input;
  const named = input.names.includes(name) ? input.env[name] : undefined;
  const value = named ?? (await fromFiles(input.files)).get(name);
  if (value === undefined) {
    return undefined;
  }
  const refusal = refusalOf(name, value, input.reserved);
  if (refusal !== undefined) {
    throw new Error(refusal);
  }
  return value;
}
