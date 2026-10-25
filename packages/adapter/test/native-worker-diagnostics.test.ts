import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown, type OutputChunk } from 'rolldown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditError } from '../src/dependencies.ts';
import { nativeLoadsPlugin } from '../src/native-loads.ts';

const PREFIX =
  'A retained Node Worker has unclassified owned native child dependencies; analysis site ';
const SOURCE_IMPORT = "import {Worker} from 'node:worker_threads';";
interface Diagnostic {
  readonly analysisSha256: string;
  readonly end: number;
  readonly kind: 'call' | 'constructor' | 'return';
  readonly sourceSha256: string;
  readonly start: number;
}

function site(error: unknown): { readonly message: string; readonly value: Diagnostic } {
  if (!(error instanceof AuditError) || !error.message.startsWith(PREFIX))
    throw new Error('Expected an authored child-marker diagnostic');
  const value: unknown = JSON.parse(error.message.slice(PREFIX.length));
  if (typeof value !== 'object' || value === null) throw new Error('Expected site metadata');
  return { message: error.message, value: value as Diagnostic };
}

describe('bounded original child-marker diagnostics', () => {
  let directory: string;
  let entry: string;
  let binary: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-child-diagnostic-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    entry = path.join(directory, 'entry.mjs');
    binary = path.join(directory, 'private-native.node');
    await writeFile(binary, new Uint8Array([0, 1, 2]));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function classify(source: string, extension = 'mjs', nodeTarget = false) {
    entry = path.join(directory, `entry.${extension}`);
    await writeFile(entry, source);
    const proof = nativeLoadsPlugin([{ id: '/native', assets: { entry, binary } }], { nodeTarget });
    await using build = await rolldown({
      input: entry,
      platform: 'neutral',
      plugins: [proof.plugin],
      external: ['node:worker_threads'],
    });
    const output = await build.generate({ format: 'esm' });
    const chunk = output.output.find((part): part is OutputChunk => part.type === 'chunk');
    if (chunk === undefined) throw new Error('Expected the authored diagnostic chunk');
    try {
      await proof.retained(chunk);
    } catch (error) {
      return { ...site(error), chunk: chunk.code };
    }
    throw new Error('Expected the unchanged native child refusal');
  }

  it.each([
    ['constructor', "export const start=()=>new Worker('source',{eval:true});"],
    ['return', 'export const lookup=()=>Worker;'],
    ['call', 'export const value=consume(Worker);'],
  ] as const)('records only source identity and original %s analysis range', async (kind, code) => {
    const source = SOURCE_IMPORT + code;
    const diagnostic = await classify(source);
    const start = source.lastIndexOf('Worker');
    const sha256 = createHash('sha256').update(source).digest('hex');

    expect(diagnostic.value).toStrictEqual({
      analysisSha256: sha256,
      end: start + 'Worker'.length,
      kind,
      sourceSha256: sha256,
      start,
    });
    expect(diagnostic.chunk).toMatch(/__UPWIND_NATIVE_WORKER_CHILD__\("0"\)/u);
    expect(diagnostic.chunk).not.toContain(sha256);
  });

  it('does not expose paths, binary identities, source text or fixture credential values', async () => {
    const credential = `private-fixture-secret-${'x'.repeat(10_000)}`;
    const source = `${SOURCE_IMPORT}const credential=${JSON.stringify(credential)};export const get=()=>Worker;`;
    const diagnostic = await classify(source);

    expect(diagnostic.message.length).toBeLessThan(400);
    expect(diagnostic.message).not.toContain(directory);
    expect(diagnostic.message).not.toContain(binary);
    expect(diagnostic.message).not.toContain(credential);
    expect(diagnostic.message).not.toContain('const credential');
    await expect(readFile(entry, 'utf8')).resolves.toBe(source);
  });

  it('distinguishes original TypeScript input identity from analysis coordinates', async () => {
    const source = `${SOURCE_IMPORT}const count:number=1;export const get=():typeof Worker=>Worker;`;
    const diagnostic = await classify(source, 'ts');

    expect(diagnostic.value.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
    expect(diagnostic.value.analysisSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(diagnostic.value.analysisSha256).not.toBe(diagnostic.value.sourceSha256);
    expect(diagnostic.value.kind).toBe('return');
    expect(diagnostic.value.end - diagnostic.value.start).toBe('Worker'.length);
  });

  it('keeps the registered marker count and ordinal arguments separate from diagnostics', async () => {
    const source = `${SOURCE_IMPORT}export const first=()=>Worker;export const second=()=>Worker;`;
    const diagnostic = await classify(source);
    const ids = [...diagnostic.chunk.matchAll(/__UPWIND_NATIVE_WORKER_CHILD__\("(\d+)"\)/gu)].map(
      (match) => match[1] ?? '',
    );

    expect(ids.toSorted((left, right) => Number(left) - Number(right))).toStrictEqual(['0', '1']);
    expect(
      Object.keys(diagnostic.value).toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(['analysisSha256', 'end', 'kind', 'sourceSha256', 'start']);
  });

  it('identifies the scalar-only compiler namespace return during strict Node recheck', async () => {
    const source =
      "module.exports=[1,ctx=>{const ns=ctx.x('node:worker_threads',()=>require('node:worker_threads'));ctx.v(ns.isMainThread);}];";
    const diagnostic = await classify(source, 'mjs', true);

    expect(diagnostic.value.kind).toBe('return');
    expect(diagnostic.value.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
    expect(source.slice(diagnostic.value.start, diagnostic.value.end)).toBe(
      "require('node:worker_threads')",
    );
  });
});
