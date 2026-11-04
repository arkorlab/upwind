import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it, vi } from 'vitest';

import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';
import { NODE_JWT_COMPILER_PROFILES } from '../src/node-jwt-compiler-profiles.ts';
import type { NodeJwtCompilerProof } from '../src/node-jwt-compiler-proof.ts';
import { nodeFastJwtBindingSite } from '../src/node-jwt-fast-sites.ts';

// The proof itself needs a whole qualified graph; here it stands for one that reads fast-jwt's site.
vi.mock(import('../src/node-jwt-compiler-proof.ts'), async () => {
  const sites = await import('../src/node-jwt-fast-sites.ts');
  return {
    nodeJwtCompilerSite: (proof: unknown, _file: string, _code: string, program: unknown) => {
      const node = proof === undefined ? undefined : sites.nodeFastJwtBindingSite(program);
      return node === undefined ? undefined : { kind: 'loader', node };
    },
  };
});

const require = createRequire(import.meta.url);
const ROOTS = {
  '16.4.3': path.dirname(require.resolve('next-16-4-3/package.json')),
  '16.4.4': path.dirname(require.resolve('next-16-4-4/package.json')),
} as const;
const FILE = path.join(ROOTS['16.4.4'], 'dist/compiled/fast-jwt/index.js');
const CODE = readFileSync(FILE, 'utf8');
const GUARD =
  'if(!o.kStringMaxLength){try{o.kStringMaxLength=process.binding("buffer").kStringMaxLength}catch(e){}}';
/** The same read as Rolldown may render it, with no braces and no catch binding. */
const BRACELESS =
  'if(!o.kStringMaxLength)try{o.kStringMaxLength=process.binding("buffer").kStringMaxLength}catch{}';

function withGuard(replacement: string): string {
  return CODE.replace(GUARD, () => replacement);
}
function siteIn(code: string): string | undefined {
  const site = nodeFastJwtBindingSite(parseAst(code, { sourceType: 'commonjs' }));
  return site === undefined ? undefined : code.slice(site.start, site.end);
}

describe("fast-jwt's one Node loader read, in Next.js 16.4.4", () => {
  it('holds each JWT profile to its release’s installed bytes', () => {
    for (const profile of NODE_JWT_COMPILER_PROFILES) {
      const bytes = readFileSync(path.join(ROOTS[profile.release], profile.suffix));

      expect([profile.name, bytes.byteLength]).toStrictEqual([profile.name, profile.bytes]);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(profile.sha256);
    }
  });

  it('finds the guarded process.binding("buffer") read of safer-buffer, and only that', () => {
    expect(CODE.split(GUARD)).toHaveLength(2);
    expect(siteIn(CODE)).toBe('process.binding');
    expect(siteIn(withGuard(BRACELESS))).toBe('process.binding');
  });

  it.each([
    ['another binding', GUARD.replace('"buffer"', '"util"')],
    ['a second read', `${GUARD};process.binding("buffer");`],
    ['a computed read', `${GUARD};process["binding"];`],
    ['a code compiler', `${GUARD};eval("1");`],
    ['a handled failure', GUARD.replace('catch(e){}', 'catch(e){o.failed=1}')],
    ['a finalizer', GUARD.replace('catch(e){}', 'catch(e){}finally{}')],
    ['an alternative', `${GUARD.slice(0, -1)}}else{}`],
    ['another guard', GUARD.replace('if(!o.', 'if(!a.')],
    ['an unguarded read', GUARD.replace('if(!o.kStringMaxLength)', '')],
  ])('refuses %s', (_name, replacement) => {
    expect(siteIn(withGuard(replacement))).toBeUndefined();
  });

  it('leaves nothing else of the bundle to the closure walker to refuse', () => {
    const proof = {} as NodeJwtCompilerProof;

    expect(dynamicNodeClosureRefusal(FILE, CODE)).toBe(
      'an unproved Node module loader or code compiler',
    );
    expect(dynamicNodeClosureRefusal(FILE, CODE, proof)).toBeUndefined();
  });
});
