import assert from 'node:assert/strict';

import { FIXTURE_FILES, NEXT_RELEASES, SERVER_MINIFICATION_OFF_CONFIG } from './inputs.mts';

export interface PagesHandlerProfileInputs {
  readonly next: { readonly version: keyof typeof NEXT_RELEASES; readonly swc: string };
  readonly serverMinification: 'default' | 'off';
  readonly outputName: string;
  readonly artifactName: string;
  readonly files: readonly {
    readonly source: string;
    readonly target: string;
    readonly sha256: string;
  }[];
}

const OFF = '--server-minification=off';
type Release = keyof typeof NEXT_RELEASES;
/** The releases a run asks for by name; 16.4.3 is the one it compiles with unasked. */
const LATER_RELEASES = (Object.keys(NEXT_RELEASES) as Release[]).filter(
  (version) => version !== '16.4.3',
);
const LATER_OPTIONS = LATER_RELEASES.map((version) => `--next=${version}`).join(' or ');

/** Fixed public source selection only; this does not compile, collect or qualify any output. */
export function pagesHandlerProfileInputs(args: readonly string[]): PagesHandlerProfileInputs {
  const later = LATER_RELEASES.find((version) => args[0] === `--next=${version}`);
  const rest = later === undefined ? args : args.slice(1);
  assert.ok(
    rest.length === 0 || (rest.length === 1 && rest[0] === OFF),
    `Pass no arguments, or ${LATER_OPTIONS} and/or ${OFF} in that order`,
  );
  const off = rest.length === 1;
  const version: Release = later ?? '16.4.3';
  const release: { readonly files: Readonly<Record<string, string>> } = NEXT_RELEASES[version];
  const files = Object.entries(FIXTURE_FILES).map(([target, digest]) => {
    const replacement = off && target === 'next.config.mjs';
    const released = release.files[target];
    if (released !== undefined) {
      return Object.freeze({ source: `fixture-${version}/${target}`, target, sha256: released });
    }
    return Object.freeze({
      source: replacement ? 'fixture/server-minification-off.next.config.mjs' : `fixture/${target}`,
      target,
      sha256: replacement ? SERVER_MINIFICATION_OFF_CONFIG : digest,
    });
  });
  const named = later === undefined ? '' : `-next-${version}`;
  const suffix = `${named}${off ? '-server-minification-off' : ''}`;
  return Object.freeze({
    next: Object.freeze({ version, swc: NEXT_RELEASES[version].swc }),
    serverMinification: off ? 'off' : 'default',
    outputName: `independent-pages-handler-profile${suffix}`,
    artifactName: `UNQUALIFIED-public-pages-handler${suffix}`,
    files: Object.freeze(files),
  });
}
