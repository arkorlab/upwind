import { describe, expect, it } from 'vitest';

import {
  previewCertifiedNodeCachePolicy,
  previewCertifiedNodeNextPolicy,
  rewriteCertifiedNodeNextFile,
  type NodeNextRewriteInput,
} from '../src/node-next-rewrite-proof.ts';

const INPUT: NodeNextRewriteInput = {
  projectDir: '/authored',
  entries: [],
  patch: {
    projectDir: '/authored',
    distDir: '/authored/.next',
    chunks: [],
    instrumentation: undefined,
    wasm: [],
  },
};
const FILES = [
  '/authored/node_modules/next/dist/server/route-modules/pages/module.compiled.js',
  '/authored/node_modules/next/dist/compiled/next-server/pages.runtime.prod.js',
  '/authored/node_modules/next/dist/server/lib/router-utils/instrumentation-globals.external.js',
  '/authored/ordinary.js',
];
const CODE = 'if(process.env.TURBOPACK)module.exports=require("./authored-target");';

describe('native policy preview rejects unqualified authored DATA', () => {
  it.each(FILES)('supplies no inspection or physical authority without a proof for %s', (file) => {
    const original = { file, code: CODE };

    expect(previewCertifiedNodeNextPolicy(undefined, INPUT, original)).toBeUndefined();
    expect(previewCertifiedNodeCachePolicy(undefined, INPUT, original)).toBeUndefined();
    expect(original).toStrictEqual({ file, code: CODE });
  });

  it.each(FILES)('rejects forged or copied tokens before any record lookup for %s', (file) => {
    const original = { file, code: CODE };
    const forged = { qualification: 'UNQUALIFIED', records: new Map([[file, CODE]]) };

    expect(() => {
      Reflect.apply(previewCertifiedNodeNextPolicy, undefined, [forged, INPUT, original]);
    }).toThrow('certificate');
    expect(() => {
      Reflect.apply(previewCertifiedNodeNextPolicy, undefined, [{ ...forged }, INPUT, original]);
    }).toThrow('certificate');
    expect(() => {
      Reflect.apply(previewCertifiedNodeCachePolicy, undefined, [forged, INPUT, original]);
    }).toThrow('certificate');
  });

  it('does not read caller-supplied records or source accessors to authenticate a fake token', () => {
    let calls = 0;
    const forged = Object.defineProperty({}, 'records', {
      get() {
        calls += 1;
        return new Map();
      },
    });
    const original = Object.defineProperty({}, 'file', {
      get() {
        calls += 1;
        return FILES[0];
      },
    });

    expect(() => {
      Reflect.apply(previewCertifiedNodeNextPolicy, undefined, [forged, INPUT, original]);
    }).toThrow('certificate');
    expect(calls).toBe(0);
  });

  it.each(FILES.slice(0, 3))(
    'still rejects a forged physical policy certificate for %s',
    (file) => {
      expect(() => {
        Reflect.apply(rewriteCertifiedNodeNextFile, undefined, [
          {},
          INPUT,
          { file, name: 'project/authored.js', code: CODE },
        ]);
      }).toThrow('certificate');
    },
  );
});
