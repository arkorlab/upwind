import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_FILES,
  SERVER_MINIFICATION_OFF_CONFIG,
} from '../../../tools/native-pages-handler-profile/inputs.mts';
import {
  pagesHandlerProfileInputs,
  type PagesHandlerProfileInputs,
} from '../../../tools/native-pages-handler-profile/options.mts';

const INPUTS = new URL('../../../tools/native-pages-handler-profile/', import.meta.url);
const DEFAULT_FIXTURE = '2527f3cdc79784d6a1fd003332682d651f2b1b3bce5859eb2731e4f71b7a12d4';

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function identity(profile: PagesHandlerProfileInputs): string {
  return digest(profile.files.map((file) => `${file.target}:${file.sha256}`).join('\n'));
}

async function bytePins(profile: PagesHandlerProfileInputs) {
  return Promise.all(
    profile.files.map(async (file) => {
      const bytes = await readFile(new URL(file.source, INPUTS));
      return [file.target, digest(bytes)];
    }),
  );
}

function withoutConfig(profile: PagesHandlerProfileInputs) {
  return profile.files.filter((file) => file.target !== 'next.config.mjs');
}

describe('fixed public Pages producer input selection without running the producer', () => {
  it('keeps empty argv, all original fixture bytes and the original ordered identity', async () => {
    const profile = pagesHandlerProfileInputs([]);
    const pins = Object.entries(FIXTURE_FILES);

    expect(profile.serverMinification).toBe('default');
    expect(profile.outputName).toBe('independent-pages-handler-profile');
    expect(profile.artifactName).toBe('UNQUALIFIED-public-pages-handler');
    expect(profile.files.map((file) => [file.target, file.sha256])).toStrictEqual(pins);
    expect(profile.files.map((file) => file.source)).toStrictEqual(
      Object.keys(FIXTURE_FILES).map((name) => `fixture/${name}`),
    );
    await expect(bytePins(profile)).resolves.toStrictEqual(pins);
    expect(identity(profile)).toBe(DEFAULT_FIXTURE);
  });

  it('replaces only the target config and separates the off identity and output names', async () => {
    const original = pagesHandlerProfileInputs([]);
    const off = pagesHandlerProfileInputs(['--server-minification=off']);

    expect(off.serverMinification).toBe('off');
    expect(off.files).toHaveLength(original.files.length);
    expect(withoutConfig(off)).toStrictEqual(withoutConfig(original));
    expect(off.files.find((file) => file.target === 'next.config.mjs')).toStrictEqual({
      source: 'server-minification-off.next.config.mjs',
      target: 'next.config.mjs',
      sha256: SERVER_MINIFICATION_OFF_CONFIG,
    });
    await expect(bytePins(off)).resolves.toStrictEqual(
      off.files.map((file) => [file.target, file.sha256]),
    );
    expect(identity(off)).not.toBe(DEFAULT_FIXTURE);
    expect(identity(pagesHandlerProfileInputs([]))).toBe(DEFAULT_FIXTURE);
  });

  it('keeps off output and artifact names separate from the unchanged default names', () => {
    const off = pagesHandlerProfileInputs(['--server-minification=off']);

    expect(off.outputName).toBe('independent-pages-handler-profile-server-minification-off');
    expect(off.artifactName).toBe('UNQUALIFIED-public-pages-handler-server-minification-off');
  });

  it('uses an authored pinned config that adds only experimental.serverMinification=false', async () => {
    const normal = await readFile(new URL('fixture/next.config.mjs', INPUTS), 'utf8');
    const off = await readFile(new URL('server-minification-off.next.config.mjs', INPUTS), 'utf8');
    const parsed = parseAst(off);
    const exported = parsed.body.find((node) => node.type === 'ExportDefaultDeclaration');
    const properties =
      exported?.type === 'ExportDefaultDeclaration' &&
      exported.declaration.type === 'ObjectExpression'
        ? exported.declaration.properties
        : [];
    const experimental = properties.find((property) => {
      return (
        property.type === 'Property' &&
        property.key.type === 'Identifier' &&
        property.key.name === 'experimental'
      );
    });

    expect(experimental).toMatchObject({
      value: {
        type: 'ObjectExpression',
        properties: [
          { key: { name: 'serverMinification' }, value: { type: 'Literal', value: false } },
        ],
      },
    });
    expect(off.replace('  experimental: { serverMinification: false },\n', '')).toBe(normal);
    expect(digest(normal)).toBe(FIXTURE_FILES['next.config.mjs']);
    expect(digest(off)).toBe(SERVER_MINIFICATION_OFF_CONFIG);
  });

  it.each([
    [''],
    ['--server-minification=default'],
    ['--server-minification=on'],
    ['--server-minification', 'off'],
    ['--server-minification=off', '--server-minification=off'],
    ['--server-minification=off', '--output=elsewhere'],
    ['/candidate/next.config.mjs'],
    ['--help'],
  ])('rejects an unknown or additional argument sequence %j', (...args) => {
    expect(() => pagesHandlerProfileInputs(args)).toThrow(
      'Pass no arguments or exactly --server-minification=off',
    );
  });

  it.each([[], ['--server-minification=off']])('freezes the selected input plan %j', (...args) => {
    const profile = pagesHandlerProfileInputs(args);

    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.files)).toBe(true);
    expect(profile.files.every((file) => Object.isFrozen(file))).toBe(true);
  });
});
