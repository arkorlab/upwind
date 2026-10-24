import { describe, expect, it } from 'vitest';

import { readDeploySettings } from '../../src/deploy/config.ts';
import { ownVersion } from '../../src/manifest.ts';
import { projectWith } from './project.ts';

describe("a deploy's settings", () => {
  it('fill in every default, and take the name from the package', async () => {
    const dir = projectWith({ adapterVersion: await ownVersion() });

    await expect(readDeploySettings(dir)).resolves.toStrictEqual({
      file: undefined,
      project: 'my-shop',
      workersDev: true,
      hostnames: [],
      keep: 5,
      storage: [],
      secrets: [],
      images: false,
      checks: ['/'],
      cspNonce: undefined,
      logs: false,
    });
  });

  it('take what the project configured, and a --keep over it', async () => {
    const dir = projectWith({
      adapterVersion: await ownVersion(),
      config: {
        file: 'upwind.config.ts',
        crons: [{ path: '/tick', schedule: '* * * * *' }],
        deploy: {
          name: 'storefront',
          workersDev: false,
          hostnames: ['shop.example.com'],
          keep: 2,
          storage: { UPWIND_D1: 'd1' },
          secrets: ['AUTH_SECRET'],
          cspNonce: { strictDynamic: true },
        },
      },
    });
    const settings = await readDeploySettings(dir, { keep: 0 });

    expect(settings).toMatchObject({
      file: 'upwind.config.ts',
      project: 'storefront',
      workersDev: false,
      hostnames: ['shop.example.com'],
      keep: 0,
      storage: [{ name: 'UPWIND_D1', kind: 'd1' }],
      secrets: ['AUTH_SECRET'],
      cspNonce: { mode: 'enforce', strictDynamic: true },
    });
  });

  it('refuse an adapter of another version, and one that cannot read them', async () => {
    const older = projectWith({ adapterVersion: '0.0.1' });
    const unreadable = projectWith({ adapterVersion: await ownVersion(), exportsReader: false });

    await expect(readDeploySettings(older)).rejects.toThrow(/install the same version of both/u);
    await expect(readDeploySettings(unreadable)).rejects.toThrow(
      /cannot read a deploy configuration/u,
    );
  });

  it('refuse a package name that cannot be a name on the account', async () => {
    const unnamed = projectWith({ adapterVersion: await ownVersion(), packageName: '@x/9' });

    await expect(readDeploySettings(unnamed)).rejects.toThrow(/set `deploy.name`/u);
  });
});
