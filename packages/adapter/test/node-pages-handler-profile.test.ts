import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { publicPagesCorpus } from '../../../tools/native-pages-handler-profile/format.mts';
import { FIXTURE_FILES } from '../../../tools/native-pages-handler-profile/inputs.mts';
import {
  matchReviewedPagesHandler,
  parsePagesHandlerProfile,
} from '../src/node-pages-handler-profile.ts';

const DIGEST = 'a'.repeat(64);
const source = 'module.exports = 42;\n';
const roots: string[] = [];

async function publicFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'public-pages-profile-unit-'));
  roots.push(root);
  for (const name of ['pages', 'chunks'])
    await mkdir(path.join(root, '.next/server', name), { recursive: true });
  return root;
}

function fixture(): Record<string, unknown> {
  return {
    files: [
      {
        name: 'chunks/public.js',
        sha256: createHash('sha256').update(source).digest('hex'),
        source,
      },
    ],
    inputs: {
      fixture: DIGEST,
      image: DIGEST,
      lock: DIGEST,
      next: DIGEST,
      packageManager: DIGEST,
      swc: DIGEST,
    },
    schema: 1,
    semanticClosure: 'unmapped:getHandler',
    status: 'UNQUALIFIED',
  };
}

describe('independent Pages handler profile data boundary', () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('pins both lock documents with the leading pnpm boot-document marker', async () => {
    const bytes = await readFile(
      new URL(
        '../../../tools/native-pages-handler-profile/fixture/pnpm-lock.yaml',
        import.meta.url,
      ),
    );
    const text = bytes.toString('utf8');

    expect(text.startsWith('---\n')).toBe(true);
    expect(text.match(/^---$/gmu)).toHaveLength(2);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(FIXTURE_FILES['pnpm-lock.yaml']);
  });

  it('parses immutable unqualified data without granting authority from matching self-hashes', () => {
    const input = fixture();
    const parsed = parsePagesHandlerProfile(input);
    const matched = matchReviewedPagesHandler(input);

    expect(parsed.status).toBe('UNQUALIFIED');
    expect(parsed.semanticClosure).toBe('unmapped:getHandler');
    expect(Object.isFrozen(parsed.files)).toBe(true);
    expect(Object.isFrozen(parsed.files[0])).toBe(true);
    expect(matched).toBeUndefined();
  });

  it.each([
    '../pages/a.js',
    'chunks/../a.js',
    'pages/a.js.map',
    'server/a.js',
    'chunks/key-manifest.js',
    'chunks//a.js',
  ])('refuses an unsafe or non-code path %s', (name) => {
    const input = fixture();
    input['files'] = [{ name, sha256: createHash('sha256').update(source).digest('hex'), source }];

    expect(() => parsePagesHandlerProfile(input)).toThrow('path');
  });

  it.each(['QUALIFIED', 'reviewed', true])('refuses supplied qualification %s', (status) => {
    const input = fixture();
    input['status'] = status;

    expect(() => {
      matchReviewedPagesHandler(input);
    }).toThrow('boundary');
  });

  it('refuses an external catalog, changed bytes, duplicate paths and excessive entries', () => {
    const catalog = { ...fixture(), reviewedCatalog: [DIGEST] };
    const changed = fixture();
    changed['files'] = [{ name: 'pages/index.js', sha256: DIGEST, source }];
    const duplicates = fixture();
    const files: readonly unknown[] = Array.isArray(duplicates['files']) ? duplicates['files'] : [];
    duplicates['files'] = [...files, ...files];
    const excessive = {
      ...fixture(),
      files: Array.from({ length: 257 }, () => ({ name: 'chunks/a.js', sha256: DIGEST, source })),
    };

    expect(() => {
      matchReviewedPagesHandler(catalog);
    }).toThrow('fields');
    expect(() => parsePagesHandlerProfile(changed)).toThrow('source');
    expect(() => parsePagesHandlerProfile(duplicates)).toThrow('duplicate');
    expect(() => parsePagesHandlerProfile(excessive)).toThrow('boundary');
  });

  it('collects only bounded public pages/chunks and preserves exact original bytes', async () => {
    const project = await publicFixture();
    const server = path.join(project, '.next/server');
    await writeFile(path.join(server, 'pages/index.js'), source);
    await writeFile(path.join(server, 'chunks/public.js'), `\u{FEFF}${source}`);
    await writeFile(path.join(server, 'chunks/server-reference-manifest.js'), 'private build data');
    await writeFile(path.join(server, 'chunks/public.js.map'), 'not code');
    await writeFile(path.join(server, 'root.js'), 'not code');
    const files = await publicPagesCorpus(project);
    const original = await readFile(path.join(server, 'chunks/public.js'));
    const expected = createHash('sha256').update(original).digest('hex');

    expect(files.map((file) => file.name)).toStrictEqual(['chunks/public.js', 'pages/index.js']);
    expect(files[0]?.source).toBe(`\u{FEFF}${source}`);
    expect(files[0]?.sha256).toBe(expected);
    expect(parsePagesHandlerProfile({ ...fixture(), files }).status).toBe('UNQUALIFIED');
  });

  it('rejects links, invalid UTF-8 and oversized code before allocating its contents', async () => {
    const project = await publicFixture();
    const file = path.join(project, '.next/server/chunks/public.js');
    const outside = path.join(project, 'outside.js');
    await writeFile(outside, source);
    await symlink(outside, file);

    await expect(publicPagesCorpus(project)).rejects.toThrow('symlinks');

    await rm(file);
    await writeFile(file, Buffer.from([0xff]));

    await expect(publicPagesCorpus(project)).rejects.toThrow('encoded data');

    await truncate(file, 16_777_217);

    await expect(publicPagesCorpus(project)).rejects.toThrow('budget');
  });
});
