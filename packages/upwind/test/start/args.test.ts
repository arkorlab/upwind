import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseBuildRequest } from '../../src/build/args.ts';
import { parseStartRequest } from '../../src/start/args.ts';

describe('native commands', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('selects the native target without changing an unspecified build target', () => {
    expect(parseBuildRequest(['--target=node']).answer).toBeUndefined();
    expect(parseBuildRequest(['--target=node'])).toStrictEqual({
      answer: undefined,
      options: { projectDir: process.cwd(), target: 'node' },
    });
    expect(parseBuildRequest([])).toStrictEqual({
      answer: undefined,
      options: { projectDir: process.cwd() },
    });
    expect(() => parseBuildRequest(['--target=bun'])).toThrow('--target');
  });

  it('resolves writable cache paths outside the immutable artifact', () => {
    vi.stubEnv('PORT', '');
    vi.stubEnv('UPWIND_NODE_CACHE_DIR', undefined);
    vi.stubEnv('UPWIND_NODE_HOSTNAME', undefined);
    vi.stubEnv('UPWIND_NODE_ORIGIN', undefined);

    expect(parseStartRequest(['site'])).toStrictEqual({
      answer: undefined,
      options: {
        projectDir: path.resolve('site'),
        port: 3000,
        hostname: '0.0.0.0',
        origin: undefined,
        cacheDir: path.resolve('site/.upwind/node-cache'),
        envFiles: [],
      },
    });
  });

  it('takes explicit listen settings and normalizes IPv6', () => {
    vi.stubEnv('PORT', '3500');
    const parsed = parseStartRequest([
      '-p',
      '0',
      '-H',
      '[::1]',
      '--origin',
      'https://app.example',
      '--env-file',
      'secrets.env',
    ]);

    expect(parsed.answer).toBeUndefined();

    // eslint-disable-next-line vitest/no-conditional-in-test -- narrow the parsed command union
    if (parsed.answer !== undefined) throw new Error('expected start');

    expect(parsed.options.port).toBe(0);
    expect(parsed.options.hostname).toBe('::1');
    expect(parsed.options.origin).toBe('https://app.example');
    expect(parsed.options.envFiles).toStrictEqual([path.resolve('secrets.env')]);
  });

  it.each(['-1', '65536', '1e3', ' 3000', 'NaN'])('rejects invalid port %s', (port) => {
    expect(() => parseStartRequest(['--port', port])).toThrow(/port|origin|URL/u);
  });

  it.each([
    'https://app.example/path',
    'https://user@app.example',
    'file:///tmp',
    'https://app.example/?q=x',
  ])('rejects origin %s', (origin) => {
    expect(() => parseStartRequest(['--origin', origin])).toThrow(/port|origin|URL/u);
  });

  it('answers help without reading an invalid runtime environment', () => {
    vi.stubEnv('PORT', 'invalid');

    expect(parseStartRequest(['--help'])).toStrictEqual({ answer: 'help' });
  });
});
