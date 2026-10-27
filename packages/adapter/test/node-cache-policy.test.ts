import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  nodeCachePolicyConfig,
  nodeCachePolicyExpectedEdits,
  nodeCachePolicyPatch,
  nodeCachePolicyRemovedRanges,
} from '../src/node-cache-policy.ts';
import { cacheHandlersPatch } from '../src/patches/cache-handlers.ts';

// Neither the authored methods nor any loader in these strings is executed.
const SOURCE = [
  'async function kinds(nextConfig){const {cacheHandlers}=nextConfig;if(!cacheHandlers)return;',
  'for(const handler of Object.values(cacheHandlers)){if(!handler)continue;',
  // eslint-disable-next-line no-template-curly-in-string -- Original compiled import expression.
  'set(interop(await dynamicImport(format(`${root}/${this.distDir}`,handler))))}}',
  'async function incremental(nextConfig){const {cacheHandler}=nextConfig;',
  'if(cacheHandler)return interop(await dynamicImport(format(this.distDir,cacheHandler)));',
  'return supportedDefaultCache(nextConfig)}',
].join('');
const CONTEXT = {
  projectDir: '/project',
  distDir: '/project/.next',
  chunks: [],
  instrumentation: undefined,
  wasm: [],
};
const RUNTIME = '/next/dist/compiled/next-server/pages.runtime.prod.js';

describe('the native Node custom-handler policy', () => {
  let directory: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-node-cache-policy-'));
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('guards the two custom branches while retaining their default-path predicates and continuation', () => {
    const context = {
      projectDir: '/project',
      distDir: '/project/.next',
      chunks: [],
      instrumentation: undefined,
      wasm: [],
    };
    const result = nodeCachePolicyPatch.apply(
      SOURCE,
      '/next/dist/compiled/next-server/pages.runtime.prod.js',
      context,
    );

    expect(result.edits).toBe(2);

    const unchanged = [
      'if(!cacheHandlers)return;',
      'if(!handler)continue;',
      'if(cacheHandler)return (()=>{throw new Error(',
      'return supportedDefaultCache(nextConfig)',
    ];

    expect(unchanged.every((text) => result.contents.includes(text))).toBe(true);
    expect(result.contents).toContain('cacheHandlers is unsupported in native Node Functions');
    expect(result.contents).toContain('cacheHandler is unsupported in native Node Functions');
    expect(result.contents).not.toContain('dynamicImport(');
    expect(result.contents).not.toContain('Promise.reject');
  });

  it('does not change the separate Worker policy or context', () => {
    const context = {
      projectDir: '/project',
      distDir: '/project/.next',
      chunks: [],
      instrumentation: undefined,
      wasm: [],
    };
    const worker = cacheHandlersPatch.apply(
      SOURCE,
      '/next/dist/compiled/next-server/pages.runtime.prod.js',
      context,
    );

    expect(worker.contents).toContain('this build configured no cache handler');
    expect(worker.contents).not.toContain('native Node Functions');
    expect(context).not.toHaveProperty('cacheHandlers');
  });

  it.each(['"', "'"])(
    'guards only the literal optimizeCss load with %s quotes and retains its branch',
    (quote) => {
      const call = `require(${quote}critters${quote})`;
      const source = `${SOURCE}function render(options){if(options.optimizeCss){const Css=${call};return new Css(options)}return html;}`;
      const result = nodeCachePolicyPatch.apply(source, RUNTIME, CONTEXT);
      const ranges = nodeCachePolicyRemovedRanges(source);

      expect(result.edits).toBe(3);
      expect(nodeCachePolicyExpectedEdits(source)).toBe(3);
      expect(ranges).toHaveLength(2);
      expect(ranges[0]?.end).toBeLessThanOrEqual(ranges[1]?.start ?? -1);
      expect(result.contents).not.toContain(call);
      expect(result.contents).toContain(
        'experimental.optimizeCss is unsupported in native Node Functions',
      );
      expect(result.contents).toContain('if(options.optimizeCss){const Css=(()=>{throw new Error(');
      expect(result.contents).toContain('return new Css(options)}return html;');
    },
  );

  it.each([
    'other.require("critters");',
    'require?.("critters");',
    'require(name);',
    'import("critters");',
    'require("another-package");',
    'require("crit\\x74ers");',
    'const message=\'require("critters")\';',
    '/* require("critters") */',
    'function local(require){return require("critters")}',
    'const local=class require{method(){return require("critters")}};',
  ])('leaves calls outside the fixed direct literal load unchanged: %s', (other) => {
    const source = `${SOURCE}${other}`;
    const result = nodeCachePolicyPatch.apply(source, RUNTIME, CONTEXT);

    expect(result.contents).toContain(other);
    expect(result.edits).toBe(2);
    expect(nodeCachePolicyExpectedEdits(source)).toBe(2);
    expect(nodeCachePolicyRemovedRanges(source)).toHaveLength(2);
  });

  it('refuses multiple optimizeCss calls rather than changing an ambiguous source', () => {
    const source = `${SOURCE}require("critters");require('critters');`;

    expect(() => nodeCachePolicyPatch.apply(source, RUNTIME, CONTEXT)).toThrow(
      'ambiguous optimizeCss',
    );
    expect(() => nodeCachePolicyExpectedEdits(source)).toThrow('ambiguous optimizeCss');
  });

  it('continues requiring both handler edit ranges when optimizeCss is present', () => {
    const source = 'function render(){return require("critters")}';

    expect(() => nodeCachePolicyPatch.apply(source, RUNTIME, CONTEXT)).toThrow(
      'import edit bounds',
    );
    expect(() => nodeCachePolicyExpectedEdits(source)).toThrow('import edit bounds');
  });

  it.each([
    '{"config":{}}',
    '{"config":{"cacheHandler":null,"cacheHandlers":null}}',
    '{"config":{"cacheHandler":"","cacheHandlers":{}}}',
    '{"config":{"cacheHandlers":{"default":"","remote":null}}}',
    '{"config":{"experimental":{}}}',
    '{"config":{"experimental":{"optimizeCss":false}}}',
    '{"config":{"experimental":{"otherOption":true,"optimizeCss":false}}}',
  ])('seals an inert configuration with no declared custom loader: %s', async (code) => {
    const file = path.join(directory, 'required-server-files.json');
    await writeFile(file, code);
    const seal = await nodeCachePolicyConfig(directory);

    expect(seal.file).toBe(file);
    expect(seal.sha256).toMatch(/^[\da-f]{64}$/u);
    expect(Object.isFrozen(seal)).toBe(true);
  });

  it.each([
    '{"config":{"cacheHandler":"/custom.js"}}',
    '{"config":{"cacheHandler":1}}',
    '{"config":{"cacheHandlers":{"default":"../custom.js"}}}',
    '{"config":{"cacheHandlers":["custom.js"]}}',
    '{"config":{"cacheHandlers":true}}',
    '{"config":{},"config":{"cacheHandler":"custom.js"}}',
    '{"config":{"cacheHandler":"custom.js","cacheHandler":null}}',
    '{"config":{"cacheHandlers":{"default":"custom.js","default":null}}}',
    '{"config":{"experimental":{"optimizeCss":true}}}',
    '{"config":{"experimental":{"optimizeCss":{}}}}',
    '{"config":{"experimental":{"optimizeCss":"yes"}}}',
    '{"config":{"experimental":{"optimizeCss":1}}}',
    '{"config":{"experimental":{"optimizeCss":null}}}',
    '{"config":{"experimental":{"optimizeCss":0}}}',
    '{"config":{"experimental":{"optimizeCss":""}}}',
    '{"config":{"experimental":null}}',
    '{"config":{"experimental":false}}',
    '{"config":{"experimental":[]}}',
    '{"config":{"experimental":"unknown"}}',
    '{"config":{"experimental":{"optimizeCss":true},"experimental":{}}}',
    '{"config":{"experimental":{"optimizeCss":true,"optimizeCss":false}}}',
    '{"config":{"experimental":{"optimizeCss":true,"optimizeC\\u0073s":false}}}',
    '{"config":null}',
    '{"notConfig":{}}',
    '{"config":',
  ])('rejects custom, malformed or ambiguous build configuration: %s', async (code) => {
    await writeFile(path.join(directory, 'required-server-files.json'), code);

    await expect(nodeCachePolicyConfig(directory)).rejects.toThrow(
      'Native Node custom-cache policy',
    );
  });

  it('does not accept a symlink as the recorded configuration', async () => {
    const other = path.join(directory, 'other/config.json');
    await mkdir(path.dirname(other));
    await writeFile(other, '{"config":{}}');
    await symlink(other, path.join(directory, 'required-server-files.json'));

    await expect(nodeCachePolicyConfig(directory)).rejects.toThrow('physical source');
  });
});
