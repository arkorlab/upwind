import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { isNode, listOf, type Node } from '../src/lexical-scope.ts';
import {
  nodeManifestConstructorString,
  nodeManifestPagesConstructorString,
} from '../src/node-manifest-pages-constructor-scalar.ts';
import { assertNodeManifestTurbopackTemplateConsumer } from '../src/node-manifest-turbopack-templates.ts';
import { mutatePagesEsmFixture, pagesEsmFixture } from './fixtures/node-manifest-pages-esm.ts';

function expression(code: string): Node {
  const program: unknown = parseAst(`(${code});`);
  if (!isNode(program)) throw new Error('Expected authored scalar program');
  const statement = listOf(program, 'body')[0];
  if (!isNode(statement) || !isNode(statement['expression']))
    throw new Error('Expected authored scalar expression');
  return statement['expression'];
}

function nestedSequence(depth: number): string {
  let code = '".next"';
  for (let level = 0; level < depth; level += 1) code = `("label",${code})`;
  return code;
}

async function templateWithScalars(distDir: string, relativeProjectDir: string) {
  const input = await pagesEsmFixture();
  const dist = mutatePagesEsmFixture(input, "process.env.__NEXT_RELATIVE_DIST_DIR || ''", distDir);
  return mutatePagesEsmFixture(
    dist,
    "process.env.__NEXT_RELATIVE_PROJECT_DIR || ''",
    relativeProjectDir,
  );
}

describe('finite Pages constructor string DATA', () => {
  it.each([
    ['".next"', '.next'],
    ['""', ''],
    ['("TURBOPACK compile-time value",".next")', '.next'],
    ['("an unrelated label",".next") || ""', '.next'],
    ['(null,false,0,("label","src"))', 'src'],
    ['("label","") || ""', ''],
    ['("label",null) || ""', ''],
    ['false || ""', ''],
  ])('inspects pure scalar %s without changing its AST', (code, expected) => {
    const node = expression(code);
    const original = JSON.stringify(node);

    expect(nodeManifestPagesConstructorString('distDir', node)).toBe(expected);
    expect(nodeManifestPagesConstructorString('relativeProjectDir', node)).toBe(expected);
    expect(JSON.stringify(node)).toBe(original);
  });

  it.each([
    'process.env.__NEXT_RELATIVE_DIST_DIR',
    'unknown',
    'undefined',
    '(effect(),".next")',
    '(unknown,".next")',
    '(target.value="changed",".next")',
    '("TURBOPACK compile-time value",effect(),".next")',
    '".next" || missing()',
    '".next" || (effect(),"")',
    '".next" || "another fallback"',
    '(".next" || "","")',
    '("label",".next") && ""',
    '("label",".next") ?? ""',
    '(/literal/,".next")',
    '(0n,".next")',
    '(1e999,".next")',
    '([],".next")',
    '({},".next")',
    '(void 0,".next")',
    '(!0,".next")',
    '("label",".next"+suffix)',
    `("label",\`path\${unknown}\`)`,
    '("label",true)',
    '1 || ""',
  ])('declines unknown, non-string or effectful scalar %s', (code) => {
    expect(nodeManifestPagesConstructorString('distDir', expression(code))).toBeUndefined();
  });

  it.each(['page', 'pathname', 'definition', 'nextConfigOutput', '__proto__'])(
    'does not generalize the scalar profile to %s',
    (name) => {
      expect(nodeManifestPagesConstructorString(name, expression('".next"'))).toBeUndefined();
      expect(nodeManifestConstructorString('pages', name, expression('".next"'))).toBe(false);
    },
  );

  it.each(['pages', 'pages-api', 'app-route'])(
    'preserves the existing direct-string behavior for %s',
    (kind) => {
      expect(nodeManifestConstructorString(kind, 'distDir', expression('".next"'))).toBe(true);
      expect(nodeManifestConstructorString(kind, 'relativeProjectDir', expression('`src`'))).toBe(
        true,
      );
    },
  );

  it.each(['pages-api', 'app-route'])(
    'does not add compound constructor expressions to %s',
    (kind) => {
      const value = expression('("label",".next") || ""');

      expect(nodeManifestConstructorString(kind, 'distDir', value)).toBe(false);
    },
  );

  it('counts fallback operands and bounds sequence depth and literal count', () => {
    const atLimit = `(${Array.from({ length: 62 }, () => '0').join(',')},".next") || ""`;
    const beyond = `(${Array.from({ length: 63 }, () => '0').join(',')},".next") || ""`;
    const atDepth = expression(nestedSequence(32));
    const beyondDepth = expression(nestedSequence(33));

    expect(nodeManifestPagesConstructorString('distDir', expression(atLimit))).toBe('.next');
    expect(nodeManifestPagesConstructorString('distDir', expression(beyond))).toBeUndefined();
    expect(nodeManifestPagesConstructorString('distDir', atDepth)).toBe('.next');
    expect(nodeManifestPagesConstructorString('distDir', beyondDepth)).toBeUndefined();
  });

  it.each([
    { expressions: [] },
    { expressions: [expression('"only one"')] },
    { expressions: [undefined, expression('".next"')] },
    { expressions: [expression('"label"'), { type: 'SpreadElement', argument: expression('x') }] },
  ])('declines a malformed sequence $expressions', (shape) => {
    const node = { ...expression('("label",".next")'), ...shape };

    expect(nodeManifestPagesConstructorString('distDir', node)).toBeUndefined();
  });
});

describe('full original Pages template scalar inspection', () => {
  it.each([
    ['("label",".next") || ""', '(null,false,"src")'],
    ['("label","") || ""', '("other label","") || ""'],
  ])('preserves complete template and normalization proof for %s', async (dist, relative) => {
    const input = await templateWithScalars(dist, relative);
    const projection = input.projection;
    const original = JSON.stringify(projection);
    const proof = await assertNodeManifestTurbopackTemplateConsumer(input);

    expect(proof).toMatchObject({ kind: 'pages', requiresRuntimeNormalization: true });
    expect(proof.exports).toContain('routeModule');
    expect(proof.exports).toContain('handler');
    expect(input.projection).toBe(projection);
    expect(JSON.stringify(input.projection)).toBe(original);
    expect(proof).not.toHaveProperty('approvedCompilerSources');
  });

  it.each(['(effect(),".next")', '".next" || missing()', '(/literal/,".next")'])(
    'retains the whole-template refusal for %s',
    async (scalar) => {
      const input = await templateWithScalars(scalar, '"src"');

      await expect(assertNodeManifestTurbopackTemplateConsumer(input)).rejects.toThrow(
        'refusing native publication',
      );
    },
  );

  it('does not substitute a same-result AST for the original selected projection', async () => {
    const input = await templateWithScalars('("label",".next") || ""', '"src"');
    const altered = {
      ...input.projection,
      source: {
        ...input.projection.source,
        code: input.projection.source.code.replace('("label",".next")', () => '".next"'),
      },
    };

    await expect(
      assertNodeManifestTurbopackTemplateConsumer({ ...input, projection: altered }),
    ).rejects.toThrow('projection provenance');
  });
});
