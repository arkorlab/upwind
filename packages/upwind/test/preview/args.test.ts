import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parsePreviewRequest } from '../../src/preview/args.ts';

describe('what `upwind preview` understands', () => {
  beforeEach(() => {
    vi.stubEnv('PORT', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('serves the directory here on 3000 when nothing else is said', () => {
    expect(parsePreviewRequest([])).toStrictEqual({
      answer: undefined,
      options: {
        projectDir: process.cwd(),
        port: 3000,
        envFiles: [],
        check: false,
        crons: false,
      },
    });
  });

  it('serves on PORT, and on --port over it', () => {
    vi.stubEnv('PORT', '4000');

    expect(parsePreviewRequest(['app'])).toMatchObject({ options: { port: 4000 } });
    expect(parsePreviewRequest(['app', '-p', '5000'])).toMatchObject({ options: { port: 5000 } });
    expect(parsePreviewRequest(['app', '--port', '0'])).toMatchObject({ options: { port: 0 } });
  });

  it('takes an empty PORT for none, as `upwind dev` does', () => {
    vi.stubEnv('PORT', '');

    expect(parsePreviewRequest([])).toMatchObject({ options: { port: 3000 } });
    expect(parsePreviewRequest(['--check'])).toMatchObject({ options: { port: 0 } });
  });

  it('checks on a free port, unless --port names one', () => {
    vi.stubEnv('PORT', '4000');

    expect(parsePreviewRequest(['--check'])).toMatchObject({ options: { check: true, port: 0 } });
    expect(parsePreviewRequest(['--check', '-p', '5000'])).toMatchObject({
      options: { check: true, port: 5000 },
    });
  });

  it('fires the cron jobs only where --crons asks, and never in a check', () => {
    expect(parsePreviewRequest(['--crons'])).toMatchObject({ options: { crons: true } });
    expect(() => parsePreviewRequest(['--crons', '--check'])).toThrow(
      /--crons fires the cron jobs of a preview that serves, and --check serves nothing/u,
    );
  });

  it('resolves the directory and each env file, in the order given', () => {
    expect(
      parsePreviewRequest(['app', '--env-file', 'a.env', '--env-file', 'b.env']),
    ).toMatchObject({
      options: {
        projectDir: path.resolve('app'),
        envFiles: [path.resolve('a.env'), path.resolve('b.env')],
      },
    });
  });

  it('answers --help and --version', () => {
    expect(parsePreviewRequest(['--help'])).toStrictEqual({ answer: 'help' });
    expect(parsePreviewRequest(['-v'])).toStrictEqual({ answer: 'version' });
  });

  it.each([['1e3'], ['0x10'], [' 80'], ['65536']])('refuses %j for a port', (port) => {
    expect(() => parsePreviewRequest(['--port', port])).toThrow(/a port has to be a whole number/u);
  });

  it('refuses a PORT that is no port', () => {
    vi.stubEnv('PORT', 'eighty');

    expect(() => parsePreviewRequest([])).toThrow(/`eighty` is not/u);
  });

  it('refuses two directories, and a flag it does not implement', () => {
    expect(() => parsePreviewRequest(['a', 'b'])).toThrow(/at most one directory/u);
    expect(() => parsePreviewRequest(['--prebuilt'])).toThrow(/--prebuilt/u);
  });
});
