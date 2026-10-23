import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseDeployRequest } from '../../src/deploy/args.ts';

describe('`upwind deploy` arguments', () => {
  it('default to building and deploying the current directory', () => {
    expect(parseDeployRequest([])).toStrictEqual({
      answer: undefined,
      options: {
        projectDir: path.resolve('.'),
        prebuilt: false,
        buildOnly: false,
        envFiles: [],
        keep: undefined,
        message: undefined,
        dryRun: false,
        resetCacheKey: false,
      },
    });
  });

  it('read every option', () => {
    const request = parseDeployRequest([
      'site',
      '--prebuilt',
      '--env-file',
      'a.env',
      '--env-file',
      'b.env',
      '--keep',
      '3',
      '--message',
      'fix',
      '--dry-run',
    ]);

    expect(request).toStrictEqual({
      answer: undefined,
      options: {
        projectDir: path.resolve('site'),
        prebuilt: true,
        buildOnly: false,
        envFiles: [path.resolve('a.env'), path.resolve('b.env')],
        keep: 3,
        message: 'fix',
        dryRun: true,
        resetCacheKey: false,
      },
    });
  });

  it('answer for themselves, and refuse what they do not understand', () => {
    expect(parseDeployRequest(['--help'])).toStrictEqual({ answer: 'help' });
    expect(() => parseDeployRequest(['--force'])).toThrow(/Unknown option '--force'/u);
    expect(() => parseDeployRequest(['a', 'b'])).toThrow(/at most one directory/u);
    expect(() => parseDeployRequest(['--prebuilt', '--build-only'])).toThrow(/give one/u);
    expect(() => parseDeployRequest(['--keep', '51'])).toThrow(/whole number from 0 to 50/u);
    expect(() => parseDeployRequest(['--keep', '1.5'])).toThrow(/whole number/u);
  });
});
