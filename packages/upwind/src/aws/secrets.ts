import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

import { isCredentialVariable } from '../deploy/credentials.ts';
import type { SecretInput } from '../deploy/env.ts';

const RUNTIME_NAMES = new Set(['PORT', 'NODE_ENV', 'NEXT_RUNTIME', 'NEXT_DEPLOYMENT_ID']);
const MAX_SECRET_BYTES = 65_536;

export function reservedAwsVariable(name: string): boolean {
  return (
    isCredentialVariable(name.toUpperCase()) ||
    /^(?:AWS_|AMAZON_|UPWIND_|ARKOR_)/iu.test(name) ||
    RUNTIME_NAMES.has(name.toUpperCase())
  );
}

/** ECS supplies deployment credentials through its task role; application secrets are separate. */
export async function readAwsSecrets(input: SecretInput): Promise<ReadonlyMap<string, string>> {
  const secrets = new Map<string, string>();
  for (const file of input.files) {
    const source = await readFile(file, 'utf8');
    if (/^[\t ]*(?:export[\t ]+)?__proto__[\t ]*=/mu.test(source))
      throw new Error('an environment file cannot declare __proto__');
    for (const [name, value] of Object.entries(parseEnv(source))) secrets.set(name, value);
  }
  for (const name of input.names) {
    const value = input.env[name];
    if (value !== undefined) secrets.set(name, value);
    else if (!secrets.has(name))
      throw new Error(
        `deploy.secrets names ${name}, which neither the environment nor an --env-file sets`,
      );
  }
  for (const name of secrets.keys()) {
    if (
      !/^[A-Za-z_]\w{0,127}$/u.test(name) ||
      reservedAwsVariable(name) ||
      input.reserved.has(name)
    ) {
      throw new Error(
        `${name} is a deployment credential or reserved runtime variable, not an application secret`,
      );
    }
  }
  if (Buffer.byteLength(JSON.stringify(Object.fromEntries(secrets))) > MAX_SECRET_BYTES)
    throw new Error('application secrets exceed the Secrets Manager 64 KiB limit');
  return secrets;
}
