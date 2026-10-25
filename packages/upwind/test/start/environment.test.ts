import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { startEnvironment } from '../../src/start/environment.ts';

const OPTIONS = { projectDir: path.resolve('site'), envFiles: [] };

describe('native start environment', () => {
  it('applies listen defaults after the environment is merged', () => {
    expect(startEnvironment(OPTIONS, {}, {})).toStrictEqual({
      PORT: '3000',
      UPWIND_NODE_HOSTNAME: '0.0.0.0',
      UPWIND_NODE_CACHE_DIR: path.join(OPTIONS.projectDir, '.upwind/node-cache'),
    });
  });

  it('accepts listen settings and application variables from an environment file', () => {
    expect(
      startEnvironment(
        OPTIONS,
        {
          PORT: '8080',
          UPWIND_NODE_HOSTNAME: '[::1]',
          UPWIND_NODE_ORIGIN: 'https://from-file.example',
          UPWIND_NODE_CACHE_DIR: 'file-cache',
          APPLICATION_SETTING: 'from-file',
        },
        {},
      ),
    ).toStrictEqual({
      PORT: '8080',
      UPWIND_NODE_HOSTNAME: '::1',
      UPWIND_NODE_ORIGIN: 'https://from-file.example',
      UPWIND_NODE_CACHE_DIR: path.resolve('file-cache'),
      APPLICATION_SETTING: 'from-file',
    });
  });

  it('gives the inherited environment precedence over files', () => {
    expect(
      startEnvironment(
        OPTIONS,
        {
          PORT: '8080',
          UPWIND_NODE_HOSTNAME: 'file-host',
          UPWIND_NODE_ORIGIN: 'https://file.example',
          UPWIND_NODE_CACHE_DIR: 'file-cache',
        },
        {
          PORT: '9090',
          UPWIND_NODE_HOSTNAME: 'process-host',
          UPWIND_NODE_ORIGIN: 'https://process.example',
          UPWIND_NODE_CACHE_DIR: 'process-cache',
        },
      ),
    ).toMatchObject({
      PORT: '9090',
      UPWIND_NODE_HOSTNAME: 'process-host',
      UPWIND_NODE_ORIGIN: 'https://process.example',
      UPWIND_NODE_CACHE_DIR: path.resolve('process-cache'),
    });
  });

  it('gives explicit flags precedence over the inherited environment and files', () => {
    expect(
      startEnvironment(
        {
          ...OPTIONS,
          port: 0,
          hostname: '[::1]',
          origin: 'https://flag.example',
          cacheDir: 'flag-cache',
        },
        {
          PORT: '8080',
          UPWIND_NODE_HOSTNAME: 'file-host',
          UPWIND_NODE_ORIGIN: 'https://file.example',
          UPWIND_NODE_CACHE_DIR: 'file-cache',
        },
        {
          PORT: '9090',
          UPWIND_NODE_HOSTNAME: 'process-host',
          UPWIND_NODE_ORIGIN: 'https://process.example',
          UPWIND_NODE_CACHE_DIR: 'process-cache',
        },
      ),
    ).toMatchObject({
      PORT: '0',
      UPWIND_NODE_HOSTNAME: '::1',
      UPWIND_NODE_ORIGIN: 'https://flag.example',
      UPWIND_NODE_CACHE_DIR: path.resolve('flag-cache'),
    });
  });

  it.each(['not-a-port', '-1', '65536'])('rejects the selected environment port %s', (port) => {
    expect(() => startEnvironment(OPTIONS, { PORT: port }, {})).toThrow('port');
  });

  it('validates the selected origin after precedence is applied', () => {
    expect(() =>
      startEnvironment(OPTIONS, { UPWIND_NODE_ORIGIN: 'https://file.example/path' }, {}),
    ).toThrow('origin');
    expect(
      startEnvironment(
        { ...OPTIONS, origin: 'https://flag.example' },
        {
          UPWIND_NODE_ORIGIN: 'invalid',
        },
        {},
      ),
    ).toHaveProperty('UPWIND_NODE_ORIGIN', 'https://flag.example');
  });
});
