import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCommand } from './process.ts';
import { nativeTreeSha256 } from './receipt.ts';
import type { FargateBuildReceipt } from './types.ts';

export function assertFargateImage(receipt: FargateBuildReceipt, raw: string): void {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null)
    throw new Error('Docker returned invalid image metadata');
  const inspected = value as {
    readonly Id?: unknown;
    readonly Os?: unknown;
    readonly Architecture?: unknown;
    readonly Config?: { readonly Labels?: Readonly<Record<string, unknown>> };
  };
  if (
    inspected.Id !== receipt.imageId ||
    `${String(inspected.Os)}/${String(inspected.Architecture)}` !== receipt.platform ||
    inspected.Config?.Labels?.['io.stayingupwind.deployment'] !== receipt.deploymentId ||
    inspected.Config?.Labels?.['io.stayingupwind.base'] !== receipt.baseImageDigest
  ) {
    throw new Error('the image archive does not match its deployment receipt or target platform');
  }
}

/** Validate an archive before provisioning, including the image's own native artifact. */
export async function verifyFargateArchive(
  receipt: FargateBuildReceipt,
  run: typeof runCommand = runCommand,
): Promise<void> {
  await run('docker', ['image', 'load', '--input', receipt.archivePath], { quiet: true });
  assertFargateImage(
    receipt,
    await run('docker', ['image', 'inspect', '--format', '{{json .}}', receipt.imageId], {
      quiet: true,
    }),
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'upwind-fargate-verify-'));
  const container = `upwind-verify-${randomUUID()}`;
  let created = false;
  try {
    await run('docker', ['create', '--name', container, receipt.imageId], { quiet: true });
    created = true;
    const native = path.join(directory, 'native');
    await mkdir(native);
    await run('docker', ['cp', `${container}:/app/.`, native], { quiet: true });
    if ((await nativeTreeSha256(native)) !== receipt.nativeSha256)
      throw new Error('the image contains a different native artifact from its receipt');
  } finally {
    if (created)
      await run('docker', ['container', 'rm', container], { quiet: true }).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
