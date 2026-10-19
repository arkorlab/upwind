import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { environmentOf } from '../src/environment.ts';

describe('the environment a stack is given from .env files', () => {
  const state: { dir?: string } = {};

  beforeAll(async () => {
    state.dir = await mkdtemp(path.join(tmpdir(), 'upwind-local-env-'));
  });

  afterAll(async () => {
    if (state.dir !== undefined) {
      await rm(state.dir, { recursive: true, force: true });
    }
  });

  it('keeps every name as its own, __proto__ among them, the later file winning', async () => {
    const dir = state.dir ?? '';
    const first = path.join(dir, 'first.env');
    const second = path.join(dir, 'second.env');
    await writeFile(first, '__proto__=first\nKEPT="quoted value"\n');
    await writeFile(second, 'export __proto__ = "second"\n');

    const env = environmentOf([first, second]);

    expect(new Set(Object.keys(env))).toStrictEqual(new Set(['__proto__', 'KEPT']));
    expect(Object.getOwnPropertyDescriptor(env, '__proto__')?.value).toBe('second');
    expect(env['KEPT']).toBe('quoted value');
  });

  it('reads a file whose lines end in CRLF as Node reads one, __proto__ among them', async () => {
    const file = path.join(state.dir ?? '', 'crlf.env');
    await writeFile(file, 'A=1\r\n__proto__=windows\r\nB="two words"\r\n');

    const env = environmentOf([file]);

    expect(Object.getOwnPropertyDescriptor(env, '__proto__')?.value).toBe('windows');
    expect(env['A']).toBe('1');
    expect(env['B']).toBe('two words');
  });

  it('leaves a line inside a quoted value spanning lines as part of it', async () => {
    const file = path.join(state.dir ?? '', 'spanning.env');
    await writeFile(file, 'VALUE="first\n__proto__=inside\nlast"\nAFTER=1\n');

    const env = environmentOf([file]);

    expect(Object.hasOwn(env, '__proto__')).toBe(false);
    expect(env['VALUE']).toBe('first\n__proto__=inside\nlast');
    expect(env['AFTER']).toBe('1');
  });
});
