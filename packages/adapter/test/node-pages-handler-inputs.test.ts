import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_FILES,
  NEXT_RELEASES,
  SERVER_MINIFICATION_OFF_CONFIG,
} from '../../../tools/native-pages-handler-profile/inputs.mts';
import {
  pagesHandlerProfileInputs,
  type PagesHandlerProfileInputs,
} from '../../../tools/native-pages-handler-profile/options.mts';

const INPUTS = new URL('../../../tools/native-pages-handler-profile/', import.meta.url);
const DEFAULT_FIXTURE = '2527f3cdc79784d6a1fd003332682d651f2b1b3bce5859eb2731e4f71b7a12d4';
const INTEGRITY = /(integrity: )sha512-[\w+/]+=*/u;
/** The releases a run asks for by name. */
const LATER = ['16.4.4', '16.4.5'] as const;
/** A lock entry of `next` or an `@next/*` package, and its release. */
const RELEASE_ENTRY = /^ {2}"?(?:next|@next\/[\w-]+)@(\d+\.\d+\.\d+)[:"(]/u;
/** Whether `owner` is the lock entry of `next` or an `@next/*` package at `version`. */
function isReleaseEntry(owner: string, version: string): boolean {
  return RELEASE_ENTRY.exec(owner)?.[1] === version;
}

/** The lock entry, at two spaces, that a line belongs to. */
function ownerOf(lines: readonly string[], index: number): string {
  for (let at = index; at >= 0; at -= 1) {
    const line = lines[at] ?? '';
    if (/^ {2}\S/u.test(line)) return line;
  }
  return '';
}

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

function withoutRelease(profile: PagesHandlerProfileInputs) {
  return profile.files.filter(
    (file) => file.target !== 'package.json' && file.target !== 'pnpm-lock.yaml',
  );
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
      source: 'fixture/server-minification-off.next.config.mjs',
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
    const file = new URL('fixture/server-minification-off.next.config.mjs', INPUTS);
    const off = await readFile(file, 'utf8');
    const adapter = await readFile(new URL('adapter.mjs', file));
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
    expect(digest(adapter)).toBe(FIXTURE_FILES['adapter.mjs']);
  });

  it.each(LATER)(
    'compiles with 16.4.3 unless asked, and replaces only the manifest and lock for %s',
    async (version) => {
      const original = pagesHandlerProfileInputs([]);
      const later = pagesHandlerProfileInputs([`--next=${version}`]);
      const off = pagesHandlerProfileInputs([`--next=${version}`, '--server-minification=off']);

      expect(original.next).toStrictEqual({ version: '16.4.3', swc: NEXT_RELEASES['16.4.3'].swc });
      expect(later.next).toStrictEqual({ version, swc: NEXT_RELEASES[version].swc });
      expect(withoutRelease(later)).toStrictEqual(withoutRelease(original));
      expect(
        later.files
          .filter((file) => file.source.startsWith(`fixture-${version}/`))
          .map((file) => [file.target, file.sha256]),
      ).toStrictEqual(Object.entries(NEXT_RELEASES[version].files));
      await expect(bytePins(later)).resolves.toStrictEqual(
        later.files.map((file) => [file.target, file.sha256]),
      );
      expect(identity(later)).not.toBe(DEFAULT_FIXTURE);
      expect(withoutConfig(off)).toStrictEqual(withoutConfig(later));
    },
  );

  it.each(LATER)(
    'names %s output and artifacts apart from the unchanged 16.4.3 names',
    (version) => {
      const later = pagesHandlerProfileInputs([`--next=${version}`]);
      const off = pagesHandlerProfileInputs([`--next=${version}`, '--server-minification=off']);

      expect(later.outputName).toBe(`independent-pages-handler-profile-next-${version}`);
      expect(later.artifactName).toBe(`UNQUALIFIED-public-pages-handler-next-${version}`);
      expect(off.outputName).toBe(
        `independent-pages-handler-profile-next-${version}-server-minification-off`,
      );
      expect(off.artifactName).toBe(
        `UNQUALIFIED-public-pages-handler-next-${version}-server-minification-off`,
      );
    },
  );

  it.each(
    LATER.flatMap((version) =>
      ['package.json', 'pnpm-lock.yaml'].map((target) => [version, target]),
    ),
  )(
    'holds the %s %s to 16.4.3 but for the release and its integrities',
    async (version, target) => {
      const original = (await readFile(new URL(`fixture/${target}`, INPUTS), 'utf8')).split('\n');
      const later = (await readFile(new URL(`fixture-${version}/${target}`, INPUTS), 'utf8')).split(
        '\n',
      );
      const changed = later.flatMap((line, index) => {
        const before = original[index] ?? '';
        return line === before ? [] : [{ before, line, owner: ownerOf(later, index) }];
      });

      expect(later).toHaveLength(original.length);
      expect(changed.length).toBeGreaterThan(0);

      for (const { before, line, owner } of changed) {
        const released = before.replaceAll('16.4.3', () => version);
        // An integrity changes only in the entry of a package the release itself publishes.
        const integrity =
          isReleaseEntry(owner, version) &&
          line.replace(INTEGRITY, '$1') === released.replace(INTEGRITY, '$1');

        expect({ line, owner, kept: line === released || integrity }).toStrictEqual({
          line,
          owner,
          kept: true,
        });
      }
    },
  );

  it.each([
    [''],
    ['--server-minification=default'],
    ['--server-minification=on'],
    ['--server-minification', 'off'],
    ['--server-minification=off', '--server-minification=off'],
    ['--server-minification=off', '--output=elsewhere'],
    ['--server-minification=off', '--next=16.4.4'],
    ['--next=16.4.3'],
    ['--next=16.4.6'],
    ['--next=16.4.4', '--next=16.4.4'],
    ['--next=16.4.5', '--next=16.4.4'],
    ['/candidate/next.config.mjs'],
    ['--help'],
  ])('rejects an unknown or additional argument sequence %j', (...args) => {
    expect(() => pagesHandlerProfileInputs(args)).toThrow(
      'Pass no arguments, or --next=16.4.4 or --next=16.4.5 and/or --server-minification=off in that order',
    );
  });

  it.each([
    [],
    ['--server-minification=off'],
    ['--next=16.4.4'],
    ['--next=16.4.4', '--server-minification=off'],
    ['--next=16.4.5'],
    ['--next=16.4.5', '--server-minification=off'],
  ])('freezes the selected input plan %j', (...args) => {
    const profile = pagesHandlerProfileInputs(args);

    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.files)).toBe(true);
    expect(profile.files.every((file) => Object.isFrozen(file))).toBe(true);
  });
});
