import { describe, expect, it } from 'vitest';

import { ownVersion } from '../../src/manifest.ts';
import { readPreviewSettings } from '../../src/preview/settings.ts';
import { projectWith } from '../deploy/project.ts';

describe("a preview's settings", () => {
  it('fill in what a deploy would, where the project says nothing', async () => {
    const dir = projectWith({ adapterVersion: await ownVersion() });

    await expect(readPreviewSettings(dir)).resolves.toStrictEqual({
      file: undefined,
      secrets: [],
      cspNonce: undefined,
      hostnames: [],
      checks: ['/'],
      storage: [],
      images: false,
    });
  });

  it("take the project's deploy section as a deploy reads it", async () => {
    const dir = projectWith({
      adapterVersion: await ownVersion(),
      config: {
        file: 'upwind.config.ts',
        crons: [{ path: '/tick', schedule: '* * * * *' }],
        deploy: {
          hostnames: ['shop.example.com'],
          storage: { UPWIND_D1: 'd1', CACHE: 'kv' },
          secrets: ['AUTH_SECRET'],
          images: true,
          checks: ['/', '/api/health'],
          cspNonce: { strictDynamic: true },
        },
      },
    });

    await expect(readPreviewSettings(dir)).resolves.toStrictEqual({
      file: 'upwind.config.ts',
      secrets: ['AUTH_SECRET'],
      cspNonce: { mode: 'enforce', strictDynamic: true },
      hostnames: ['shop.example.com'],
      checks: ['/', '/api/health'],
      storage: [
        { name: 'UPWIND_D1', kind: 'd1' },
        { name: 'CACHE', kind: 'kv' },
      ],
      images: true,
    });
  });

  it('read a project whose name could not be one on an account: a preview reaches none', async () => {
    const dir = projectWith({ adapterVersion: await ownVersion(), packageName: '@acme/Shop App' });

    await expect(readPreviewSettings(dir)).resolves.toMatchObject({ checks: ['/'] });
  });

  it("refuse an adapter of another version than this command's", async () => {
    const dir = projectWith({ adapterVersion: '0.0.1' });

    await expect(readPreviewSettings(dir)).rejects.toThrow(/install the same version of both/u);
  });
});
