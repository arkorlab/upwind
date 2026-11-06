import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readAwsSecrets } from '../../src/aws/secrets.ts';

describe('AWS application secrets', () => {
  it('refuses deployment and platform variables from environment files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'upwind-aws-secrets-'));
    try {
      const file = path.join(directory, 'secrets');
      for (const name of [
        'AWS_SECRET_ACCESS_KEY',
        'AWS_PROFILE',
        'UPWIND_AWS_CACHE',
        'PORT',
        'CLOUDFLARE_API_TOKEN',
      ]) {
        await writeFile(file, `${name}=value\n`);
        await expect(
          readAwsSecrets({ files: [file], names: [], env: {}, reserved: new Set() }),
        ).rejects.toThrow('reserved');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('takes an explicitly named application secret without a Workers size limit', async () => {
    const value = 'x'.repeat(6000);
    const result = await readAwsSecrets({
      files: [],
      names: ['APP_SECRET'],
      env: { APP_SECRET: value },
      reserved: new Set(),
    });
    expect(result.get('APP_SECRET')).toBe(value);
  });
});
