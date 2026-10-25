/** Canonical Node artifact validation and materialization for the isolated real-Next CI control. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  appFunctions,
  deploymentBundleSchema,
  isNodeContainerFunction,
} from '../packages/core/src/bundle/index.ts';

const MAX_TAR = 1_073_741_824;
const MAX_FILES = 100_000;
const BLOCK = 512;

function record(value: unknown): Record<string, unknown> {
  assert(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'Expected a JSON object',
  );
  return value as Record<string, unknown>;
}

function inside(name: unknown): string {
  assert(
    typeof name === 'string' && name.length > 0 && name.length <= 240,
    'Invalid artifact name',
  );
  assert(!name.startsWith('/') && !/[\\:\p{Cc}]/u.test(name), 'Invalid artifact path');
  assert(
    name.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Noncanonical artifact path',
  );
  return name;
}

interface Member {
  readonly name: string;
  readonly bytes: Buffer;
  readonly mode: number;
}

function field(header: Buffer, offset: number, size: number): string {
  return (
    new TextDecoder('utf-8', { fatal: true })
      .decode(header.subarray(offset, offset + size))
      .split('\0')[0] ?? ''
  );
}

function octal(header: Buffer, offset: number, size: number): number {
  const text = field(header, offset, size).trim();
  assert(/^[0-7]+$/u.test(text), 'Invalid tar number');
  return Number.parseInt(text, 8);
}

function members(bytes: Buffer): Member[] {
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_TAR });
  const found: Member[] = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    assert.equal(field(header, 257, 6), 'ustar', 'Only canonical USTAR is accepted');
    assert.equal(field(header, 156, 1), '0', 'Only regular tar files are accepted');
    const prefix = field(header, 345, 155);
    const name = inside(`${prefix === '' ? '' : `${prefix}/`}${field(header, 0, 100)}`);
    assert(!names.has(name), 'Duplicate tar member');
    for (const old of names)
      assert(
        !name.startsWith(`${old}/`) && !old.startsWith(`${name}/`),
        'Tar file/directory conflict',
      );
    names.add(name);
    const expected = octal(header, 148, 8);
    const checked = Buffer.from(header);
    checked.fill(0x20, 148, 156);
    assert.equal(
      checked.reduce((sum, byte) => sum + byte, 0),
      expected,
      'Tar checksum mismatch',
    );
    const size = octal(header, 124, 12);
    const mode = octal(header, 100, 8);
    assert(mode === 0o644 || mode === 0o755, 'Unexpected artifact executable bits');
    assert(
      Number.isSafeInteger(size) && offset + BLOCK + size <= tar.length,
      'Truncated tar member',
    );
    found.push({ name, bytes: tar.subarray(offset + BLOCK, offset + BLOCK + size), mode });
    assert(found.length <= MAX_FILES, 'Artifact contains too many files');
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  assert.equal(tar.length - offset, BLOCK * 2, 'Unexpected tar trailer');
  assert(
    tar.subarray(offset).every((byte) => byte === 0),
    'Nonzero tar trailer',
  );
  return found;
}

async function restoreLinks(bundleRoot: string): Promise<void> {
  const raw = record(
    JSON.parse(await readFile(path.join(bundleRoot, 'upwind/links.json'), 'utf8')),
  )['links'];
  assert(Array.isArray(raw) && raw.length <= MAX_FILES, 'Invalid package links');
  const links = raw.map((value: unknown) => {
    const link = record(value);
    return { name: inside(link['path']), target: inside(link['target']) };
  });
  const names = new Set(links.map((link) => link.name));
  assert.equal(names.size, links.length, 'Duplicate package link');
  for (const link of links) {
    const physical = path.join(bundleRoot, link.target);
    assert.equal(await realpath(physical), physical, 'A package target is not physical');
    for (const value of [link.name, link.target]) {
      const parts = value.split('/');
      for (let size = 1; size < parts.length; size += 1)
        assert(!names.has(parts.slice(0, size).join('/')), 'Nested package aliases');
    }
    assert(!names.has(link.target), 'Package alias chain');
    await assert.rejects(lstat(path.join(bundleRoot, link.name)), { code: 'ENOENT' });
  }
  for (const link of links) {
    const alias = path.join(bundleRoot, link.name);
    await mkdir(path.dirname(alias), { recursive: true });
    await symlink(path.relative(path.dirname(alias), path.join(bundleRoot, link.target)), alias);
  }
}

export async function materializeNativeArtifact(
  directory: string,
  bundleRoot: string,
  nodeVersion: string,
): Promise<{ deploymentId: string; functionName: string; buildId: string }> {
  const bundle = deploymentBundleSchema.parse(
    JSON.parse(await readFile(path.join(directory, '.arkor/bundle.json'), 'utf8')),
  );
  const native = appFunctions(bundle).filter(([, spec]) => isNodeContainerFunction(spec));
  assert.equal(native.length, 1, 'The fixed Pages fixture must emit one native Function');
  const selected = native[0];
  assert(selected !== undefined);
  const [functionName, spec] = selected;
  assert(isNodeContainerFunction(spec));
  assert.deepEqual(spec.abi, {
    nodeVersion,
    nodeAbi: process.versions.modules,
    platform: 'linux',
    arch: 'x64',
    libc: 'glibc',
  });
  assert.equal(spec.entrypoint, 'upwind/server.mjs');
  const bytes = await readFile(path.join(directory, '.arkor/blobs', spec.artifact.sha256));
  assert.equal(bytes.byteLength, spec.artifact.byteLength, 'Native artifact length mismatch');
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    spec.artifact.sha256,
    'Native artifact digest mismatch',
  );
  for (const member of members(bytes)) {
    const target = path.join(bundleRoot, member.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, member.bytes, { flag: 'wx', mode: member.mode });
  }
  await restoreLinks(bundleRoot);
  const metadata = record(
    JSON.parse(await readFile(path.join(bundleRoot, 'upwind/native.json'), 'utf8')),
  )['modules'];
  assert(Array.isArray(metadata) && metadata.length > 0, 'No selected native binary');
  for (const item of metadata) {
    const entry = record(item);
    const file = inside(entry['path']);
    assert(file.endsWith('.node'));
    assert.equal(
      createHash('sha256')
        .update(await readFile(path.join(bundleRoot, file)))
        .digest('hex'),
      entry['sha256'],
    );
  }
  return {
    deploymentId: bundle.deploymentId,
    functionName,
    buildId: (await readFile(path.join(directory, '.next/BUILD_ID'), 'utf8')).trim(),
  };
}
