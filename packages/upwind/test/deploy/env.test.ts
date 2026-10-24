import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { takeCredentials } from '../../src/deploy/credentials.ts';
import { readSecret, readSecrets, reservedNames } from '../../src/deploy/env.ts';

function file(text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'upwind-deploy-env-'));
  const at = path.join(dir, '.env');
  writeFileSync(at, text);
  return at;
}

const NONE = reservedNames([]);

describe("a deployment's secrets", () => {
  it('are every variable of each file, a later file winning, and the named ones from the environment over both', async () => {
    const first = file('A=1\nB=2\n');
    const second = file('B=3\nC=4\n');
    const secrets = await readSecrets({
      files: [first, second],
      names: ['C', 'D'],
      env: { C: 'env', D: 'only-env' },
      reserved: NONE,
    });

    expect(Object.fromEntries(secrets)).toStrictEqual({ A: '1', B: '3', C: 'env', D: 'only-env' });
  });

  it('refuse a name that neither the environment nor a file sets', async () => {
    await expect(
      readSecrets({ files: [], names: ['MISSING'], env: {}, reserved: NONE }),
    ).rejects.toThrow(/names MISSING, which neither the environment nor an --env-file sets/u);
  });

  it('refuse a credential, a name the host binds, and a storage binding', async () => {
    await expect(
      readSecrets({
        files: [file('CLOUDFLARE_API_TOKEN=x\n')],
        names: [],
        env: {},
        reserved: NONE,
      }),
    ).rejects.toThrow(/Cloudflare credential/u);
    await expect(
      readSecrets({ files: [file('ARKOR_CACHE_TOKEN=x\n')], names: [], env: {}, reserved: NONE }),
    ).rejects.toThrow(/binds for itself/u);
    await expect(
      readSecrets({
        files: [file('DB=x\n')],
        names: [],
        env: {},
        reserved: reservedNames([{ name: 'DB' }]),
      }),
    ).rejects.toThrow(/binds for itself/u);
  });

  it('refuse a value over what a Worker holds, and a declaration of __proto__', async () => {
    await expect(
      readSecrets({
        files: [],
        names: ['BIG'],
        env: { BIG: 'x'.repeat(5 * 1024 + 1) },
        reserved: NONE,
      }),
    ).rejects.toThrow(/over the 5120 bytes/u);
    await expect(
      readSecrets({ files: [file('__proto__=x\n')], names: [], env: {}, reserved: NONE }),
    ).rejects.toThrow(/__proto__/u);
  });
});

describe('one secret, as a command that sends that one alone reads it', () => {
  it('is the named one from the environment over the files, else the last file that sets it', async () => {
    const first = file('CRON_SECRET=first\n');
    const second = file('CRON_SECRET=second\n');
    const input = { name: 'CRON_SECRET', files: [first, second], reserved: NONE };

    await expect(
      readSecret({ ...input, names: ['CRON_SECRET'], env: { CRON_SECRET: 'env' } }),
    ).resolves.toBe('env');
    await expect(readSecret({ ...input, names: [], env: { CRON_SECRET: 'env' } })).resolves.toBe(
      'second',
    );
    await expect(
      readSecret({ ...input, files: [], names: ['CRON_SECRET'], env: {} }),
    ).resolves.toBeUndefined();
  });

  it('reads nothing else of the files, which no other variable of theirs can stop', async () => {
    const env = file('CLOUDFLARE_API_TOKEN=token\nDB=x\nCRON_SECRET=s3cret\n');
    const input = { files: [env], names: [], env: {}, reserved: reservedNames([{ name: 'DB' }]) };

    // Every secret of a deploy is held to what a Function may be given, and these are not.
    await expect(readSecrets(input)).rejects.toThrow(/CLOUDFLARE_API_TOKEN/u);
    await expect(readSecret({ ...input, name: 'CRON_SECRET' })).resolves.toBe('s3cret');
  });

  it('is held to what a Worker variable may be, as every secret is', async () => {
    const large = file(`CRON_SECRET=${'x'.repeat(6000)}\n`);

    await expect(
      readSecret({ name: 'CRON_SECRET', files: [large], names: [], env: {}, reserved: NONE }),
    ).rejects.toThrow(/over the 5120 bytes/u);
  });
});

describe('the credentials', () => {
  it('are read once and taken out of the environment, with every other credential', () => {
    const env: Record<string, string | undefined> = {
      CLOUDFLARE_API_TOKEN: ' token ',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_API_KEY: 'key',
      CF_API_TOKEN: 'other',
      KEPT: 'yes',
    };

    expect(takeCredentials(env)).toStrictEqual({ apiToken: 'token', accountId: 'account' });
    expect(env).toStrictEqual({ KEPT: 'yes' });
  });

  it('are nothing without a token', () => {
    expect(takeCredentials({ CLOUDFLARE_ACCOUNT_ID: 'account' })).toBeUndefined();
  });
});
