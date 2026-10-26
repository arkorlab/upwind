import assert from 'node:assert/strict';

import { FIXTURE_FILES, SERVER_MINIFICATION_OFF_CONFIG } from './inputs.mts';

export interface PagesHandlerProfileInputs {
  readonly serverMinification: 'default' | 'off';
  readonly outputName: string;
  readonly artifactName: string;
  readonly files: readonly {
    readonly source: string;
    readonly target: string;
    readonly sha256: string;
  }[];
}

/** Fixed public source selection only; this does not compile, collect or qualify any output. */
export function pagesHandlerProfileInputs(args: readonly string[]): PagesHandlerProfileInputs {
  assert.ok(
    args.length === 0 || (args.length === 1 && args[0] === '--server-minification=off'),
    'Pass no arguments or exactly --server-minification=off',
  );
  const off = args.length === 1;
  const files = Object.entries(FIXTURE_FILES).map(([target, digest]) => {
    const replacement = off && target === 'next.config.mjs';
    return Object.freeze({
      source: replacement ? 'server-minification-off.next.config.mjs' : `fixture/${target}`,
      target,
      sha256: replacement ? SERVER_MINIFICATION_OFF_CONFIG : digest,
    });
  });
  return Object.freeze({
    serverMinification: off ? 'off' : 'default',
    outputName: off
      ? 'independent-pages-handler-profile-server-minification-off'
      : 'independent-pages-handler-profile',
    artifactName: off
      ? 'UNQUALIFIED-public-pages-handler-server-minification-off'
      : 'UNQUALIFIED-public-pages-handler',
    files: Object.freeze(files),
  });
}
