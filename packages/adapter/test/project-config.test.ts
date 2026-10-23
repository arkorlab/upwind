import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readProjectConfig } from '../src/project-config.ts';

function projectWith(file: string, value: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'upwind-project-config-'));
  writeFileSync(path.join(dir, file), JSON.stringify(value));
  return dir;
}

describe("a project's deploy settings", () => {
  it('are read from its own file, whole', async () => {
    const deploy = {
      name: 'shop',
      workersDev: false,
      hostnames: ['shop.example.com'],
      keep: 3,
      storage: { UPWIND_D1: 'd1', MEDIA: 'r2' },
      secrets: ['AUTH_SECRET'],
      images: true,
      checks: ['/', '/api/health'],
      cspNonce: { mode: 'report-only', strictDynamic: true },
      logs: true,
    };
    const config = await readProjectConfig(projectWith('upwind.json', { deploy }));

    expect(config).toStrictEqual({ file: 'upwind.json', crons: [], deploy });
  });

  it('are not there where the project wrote none', async () => {
    await expect(readProjectConfig(projectWith('upwind.json', {}))).resolves.toStrictEqual({
      file: 'upwind.json',
      crons: [],
    });
  });

  it('are never read from vercel.json', async () => {
    await expect(
      readProjectConfig(projectWith('vercel.json', { deploy: { name: 'shop' } })),
    ).resolves.toStrictEqual({ file: 'vercel.json', crons: [] });
  });

  it('refuse a key they do not know, which would be a setting silently not applied', async () => {
    await expect(
      readProjectConfig(projectWith('upwind.json', { deploy: { keepVersions: 3 } })),
    ).rejects.toThrow(/upwind\.json: deploy/u);
  });

  it('refuse a name, a hostname or a check no deploy could use', async () => {
    for (const deploy of [
      { name: 'Shop' },
      { name: 'a--b' },
      { name: 'x'.repeat(25) },
      { hostnames: ['https://shop.example.com'] },
      { hostnames: ['localhost'] },
      { checks: ['//evil.example'] },
      { keep: 51 },
      { storage: { DB: 'queue' } },
    ]) {
      await expect(readProjectConfig(projectWith('upwind.json', { deploy }))).rejects.toThrow(
        /upwind\.json: deploy/u,
      );
    }
  });
});
