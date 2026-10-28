import { describe, expect, it } from 'vitest';

import { nodeWsOptionalArchiveRefusal } from '../src/node-ws-archive-absence.ts';

const FILE = 'project/node_modules/.pnpm/next/node_modules/next/dist/compiled/ws/index.js';
const ROOTS = [
  'project/node_modules',
  'project/node_modules/.pnpm/node_modules',
  'project/node_modules/.pnpm/next/node_modules',
  'project/node_modules/.pnpm/next/node_modules/next/node_modules',
  'node_modules',
];

describe('absent optional WS target archive boundaries', () => {
  it('keeps unrelated physical files and package aliases', () => {
    expect(
      nodeWsOptionalArchiveRefusal(
        FILE,
        [FILE, 'project/node_modules/bufferutil-extra/index.js', 'project/other/bufferutil.js'],
        [{ path: 'project/node_modules/other', target: 'project/vendor/other' }],
      ),
    ).toBeUndefined();
  });

  it.each(ROOTS)('refuses optional package directories in the %s lookup', (root) => {
    expect(
      nodeWsOptionalArchiveRefusal(FILE, [FILE, `${root}/bufferutil/package.json`], []),
    ).toContain('present');
  });

  it.each(['', '.js', '.json', '.node'])('refuses extension lookup %s', (suffix) => {
    expect(
      nodeWsOptionalArchiveRefusal(FILE, [`project/node_modules/utf-8-validate${suffix}`], []),
    ).toContain('present');
  });

  it.each([
    'project/node_modules/bufferutil',
    'project/node_modules/bufferutil.js',
    'project/node_modules/bufferutil/index.js',
    'project/node_modules',
    'project',
  ])('refuses an alias that can supply the target through %s', (alias) => {
    expect(
      nodeWsOptionalArchiveRefusal(
        FILE,
        [FILE],
        [{ path: alias, target: 'project/vendor/native' }],
      ),
    ).toContain('present');
  });

  it.each([
    '',
    '/outside.js',
    '../outside.js',
    'project/../outside.js',
    'project\\outside.js',
    'x:y.js',
    'x\0y.js',
  ])('refuses an invalid importer coordinate %j', (file) => {
    expect(nodeWsOptionalArchiveRefusal(file, [], [])).toContain('coordinate');
  });

  it('keeps a nested package that is outside every source lookup', () => {
    expect(
      nodeWsOptionalArchiveRefusal(
        FILE,
        [FILE, 'project/node_modules/other/node_modules/bufferutil/index.js'],
        [],
      ),
    ).toBeUndefined();
  });
});
