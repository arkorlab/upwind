import { createHash } from 'node:crypto';

import { assert, describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import {
  compareNodeManifestHandlerGraphs,
  nodeManifestHandlerLiteralToken,
  type NodeManifestHandlerFingerprintRowData,
  type NodeManifestHandlerReferenceGraphData,
  type NodeManifestHandlerGraphData,
  type NodeManifestHandlerGraphInput,
  type NodeManifestHandlerImportData,
  type NodeManifestHandlerRowData,
} from '../src/node-manifest-handler-graph.ts';
import {
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackModuleId as Id,
} from '../src/node-manifest-turbopack.ts';
import { nodeManifestWholeFactoryData } from '../src/node-manifest-whole-factory-data.ts';

function row(
  runtime: string,
  moduleId: Id,
  body: string,
  options: { readonly ids?: readonly Id[]; readonly physicalId?: string } = {},
): NodeManifestHandlerRowData {
  const ids = options.ids ?? [moduleId];
  const physicalId = options.physicalId ?? `physical:${jsLiteral(moduleId)}`;
  const code = `module.exports=[${ids.map((value) => jsLiteral(value)).join(',')},(ctx)=>{${body}}];`;
  const projection = projectNodeManifestTurbopackFactory(
    { code, sha256: createHash('sha256').update(code).digest('hex') },
    moduleId,
    'dependencies',
  );
  return {
    physicalId,
    runtime,
    moduleId,
    whole: nodeManifestWholeFactoryData(projection),
    imports: projection.imports.map((entry) => {
      return {
        ...entry,
        target:
          entry.targetId === undefined
            ? { kind: 'builtin', id: entry.specifier }
            : { kind: 'module', runtime, moduleId: entry.targetId },
      };
    }),
    operations: projection,
  };
}
function graph(
  rows: readonly NodeManifestHandlerRowData[],
  nextRoot = '/authored/next',
): NodeManifestHandlerGraphData {
  const first = rows[0];
  if (first === undefined) throw new Error('Expected authored root');
  return { root: { runtime: first.runtime, moduleId: first.moduleId }, nextRoot, rows };
}
function chain(
  runtime: string,
  first: Id,
  second: Id,
  cycle = false,
): NodeManifestHandlerGraphData {
  return graph([
    row(runtime, first, `const value=ctx.i(${jsLiteral(second)});ctx.v(value);`),
    row(
      runtime,
      second,
      cycle ? `const value=ctx.r(${jsLiteral(first)});ctx.v(value);` : 'ctx.v(42);',
    ),
  ]);
}
function compare(reference: NodeManifestHandlerGraphData, actual: NodeManifestHandlerGraphData) {
  return compareNodeManifestHandlerGraphs({ reference, actual });
}
function replaceRow(
  value: NodeManifestHandlerGraphData,
  index: number,
  change: Partial<NodeManifestHandlerRowData>,
) {
  return {
    ...value,
    rows: value.rows.map((item, ordinal) => (ordinal === index ? { ...item, ...change } : item)),
  };
}
function rootRow(value: NodeManifestHandlerReferenceGraphData): NodeManifestHandlerRowData {
  const found = value.rows[0];
  if (found === undefined || found.mode === 'fingerprint')
    throw new Error('Expected authored full row');
  return found;
}
function slotFixture(): NodeManifestHandlerGraphInput {
  const reference = graph([row('ref', 1, 'ctx.v("/ROOT/reference");')]);
  const actual = graph([row('act', 9, 'ctx.v("/ROOT/actual");')]);
  return {
    reference,
    actual,
    literalSlots: {
      expected: [
        {
          key: 'directory',
          row: reference.root,
          path: ['callback', 'body', 'body', 0, 'expression', 'arguments', 0, 'value'],
          referenceValue: '/ROOT/reference',
        },
      ],
      actual: [{ key: 'directory', value: '/ROOT/actual' }],
    },
  };
}

function fingerprint(
  reference: NodeManifestHandlerRowData,
  normalized = reference.whole.canonical,
): NodeManifestHandlerFingerprintRowData {
  const whole = {
    version: reference.whole.version,
    originalSha256: reference.whole.originalSha256,
    factory: reference.whole.factory,
    selectedOrdinal: reference.whole.selectedOrdinal,
    strictContext: reference.whole.strictContext,
    ports: reference.whole.ports,
  };
  return {
    ...reference,
    mode: 'fingerprint',
    whole,
    canonicalSha256: createHash('sha256').update(normalized).digest('hex'),
  };
}

function changedSlots(mode: string): NodeManifestHandlerGraphInput {
  const input = slotFixture();
  const slots = input.literalSlots;
  assert(slots !== undefined, 'Expected authored slots');
  const actual = [...slots.actual];
  const expected = [...slots.expected];
  const definition = expected[0];
  const value = actual[0];
  assert(definition !== undefined && value !== undefined, 'Expected authored slot');
  const choices: Readonly<
    Record<string, NonNullable<NodeManifestHandlerGraphInput['literalSlots']>>
  > = {
    missing: { expected, actual: [] },
    extra: { expected, actual: [value, { key: 'unknown', value: 'other' }] },
    'duplicate-expected': { expected: [definition, definition], actual },
    'duplicate-actual': { expected, actual: [value, value] },
    'wrong-value': { expected, actual: [{ key: 'directory', value: 'wrong' }] },
    'wrong-reference': { expected: [{ ...definition, referenceValue: 'wrong' }], actual },
  };
  const choice = choices[mode];
  assert(choice !== undefined, 'Expected authored slot case');
  return { ...input, literalSlots: choice };
}

describe('always UNQUALIFIED whole handler graph DATA comparison', () => {
  it('matches a complete renamed graph and freezes ordinary evidence without granting authority', () => {
    const value = compare(chain('ref', 1, 2), chain('act', 90, 91));

    expect(value).toMatchObject({
      status: 'UNQUALIFIED',
      comparison: 'equal',
      reason: undefined,
      counts: { rows: 2, ports: 1, occurrences: 1 },
    });
    expect(value.bindings).toHaveLength(2);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.bindings[0]?.actual)).toBe(true);
    expect(Object.isFrozen(value.counts)).toBe(true);

    for (const field of ['proof', 'member', 'qualified', 'requiresSdkNormalization'])
      expect(value).not.toHaveProperty(field);
  });

  it('checks every node of a consistently mapped cycle instead of accepting a pending pair', () => {
    const actual = chain('act', 9, 10, true),
      reference = chain('ref', 1, 2, true);

    expect(compare(reference, actual).comparison).toBe('equal');

    const changed = replaceRow(
      actual,
      1,
      row('act', 10, 'const value=ctx.r(9);sideEffect();ctx.v(value);'),
    );

    expect(compare(reference, changed).comparison).toBe('different');
  });

  it('enqueues every typed registered sibling even without an import to that alias', () => {
    const reference = graph([
      row('ref', 1, 'ctx.v(42);', { ids: [1, 'two'], physicalId: 'group' }),
      row('ref', 'two', 'ctx.v(42);', { ids: [1, 'two'], physicalId: 'group' }),
    ]);
    const actual = graph([
      row('act', 9, 'ctx.v(42);', { ids: [9, 'ten'], physicalId: 'other' }),
      row('act', 'ten', 'ctx.v(42);', { ids: [9, 'ten'], physicalId: 'other' }),
    ]);
    const value = compare(reference, actual);

    expect(value.comparison).toBe('equal');
    expect(value.counts.rows).toBe(2);
    expect(value.bindings.map((item) => item.actual.moduleId)).toStrictEqual([9, 'ten']);
    expect(compare(reference, { ...actual, rows: actual.rows.slice(0, 1) }).reason).toBe(
      'alias-group',
    );
  });

  it('does not collapse two different physical registrations or choose a duplicate root winner', () => {
    const own = chain('runtime', 1, 2);
    for (const index of [0, 1]) {
      const duplicate = own.rows[index];
      assert(duplicate !== undefined, 'Expected authored duplicate');

      expect(
        compare(own, { ...own, rows: [...own.rows, { ...duplicate, physicalId: 'another' }] }),
      ).toMatchObject({ comparison: 'unsupported', reason: 'duplicate-registration' });
    }
  });

  it('requires a bijection for shared targets and keeps number/string types distinct', () => {
    const reference = graph([row('ref', 1, 'ctx.i(2);ctx.r(2);'), row('ref', 2, 'ctx.v(42);')]);
    const split = graph([
      row('act', 9, 'ctx.i(10);ctx.r(11);'),
      row('act', 10, 'ctx.v(42);'),
      row('act', 11, 'ctx.v(42);'),
    ]);

    expect(compare(reference, split).comparison).not.toBe('equal');
    expect(compare(chain('ref', 1, 2), chain('act', '9', '10')).reason).toBe('bijection');
  });

  it('preserves selected ordinals, complete vectors and physical callback grouping', () => {
    const own = graph([
      row('ref', 1, 'ctx.v(42);', { ids: [1, 2], physicalId: 'group' }),
      row('ref', 2, 'ctx.v(42);', { ids: [1, 2], physicalId: 'group' }),
    ]);

    expect(compare(own, { ...own, root: { runtime: 'ref', moduleId: 2 } }).comparison).not.toBe(
      'equal',
    );
    expect(compare(own, replaceRow(own, 1, { physicalId: 'split' })).reason).toBe('alias-group');
  });

  it.each([
    ['literal', 'ctx.v(42);', 'ctx.v(43);'],
    ['effect', 'ctx.v(42);', 'effect();ctx.v(42);'],
    ['strictness', 'ctx.v(42);', '"use strict";ctx.v(42);'],
    ['async function', 'ctx.v(()=>42);', 'ctx.v(async()=>42);'],
    ['export key', 'ctx.s(["one",0,42]);', 'ctx.s(["two",0,42]);'],
    ['ordering', 'one();two();', 'two();one();'],
  ])('preserves complete callback %s', (_label, reference, actual) => {
    const left = graph([row('ref', 1, reference)]);
    const right = graph([row('act', 9, actual)]);

    expect(compare(left, right).comparison).toBe('different');
  });

  it('requires the complete declared closure on both sides', () => {
    const own = chain('runtime', 1, 2);

    expect(compare(own, { ...own, rows: own.rows.slice(0, 1) }).reason).toBe('unresolved-target');
    expect(
      compare(own, { ...own, rows: [...own.rows, row('runtime', 3, 'ctx.v(0);')] }).reason,
    ).toBe('closure');
  });

  it('consumes every port occurrence and rejects missing, extra or wrong resolutions', () => {
    const own = graph([row('runtime', 1, 'ctx.i(2);ctx.r(2);'), row('runtime', 2, 'ctx.v(42);')]);
    const root = rootRow(own);

    const missing = replaceRow(own, 0, { imports: root.imports.slice(0, 1) });

    expect(compare(own, missing).reason).toBe('resolution');
    expect(
      compare(own, replaceRow(own, 0, { imports: [...root.imports, ...root.imports] })).reason,
    ).toBe('resolution');

    const changed = root.imports.map((entry) => {
      return {
        ...entry,
        target: { kind: 'module' as const, runtime: 'foreign', moduleId: 2 },
      };
    });

    expect(compare(own, replaceRow(own, 0, { imports: changed })).reason).toBe('resolution');
  });

  it('retains port kind, order and repeated target identity', () => {
    const ref = graph([row('ref', 1, 'ctx.i(2);ctx.r(2);'), row('ref', 2, 'ctx.v(42);')]);
    const changed = graph([row('act', 9, 'ctx.r(10);ctx.i(10);'), row('act', 10, 'ctx.v(42);')]);

    expect(compare(ref, changed).comparison).toBe('different');
  });

  it('uses only explicit builtin resolution aliases while preserving the original request', () => {
    const body = 'const value=ctx.x("path",()=>require("path"));ctx.v(value);';
    const actual = row('act', 9, body),
      root = row('ref', 1, body);
    const imported = root.imports.map((entry) => {
      return {
        ...entry,
        target: { kind: 'builtin' as const, id: 'path', aliases: ['path', 'node:path'] },
      };
    });
    const aliases = actual.imports.map((entry) => {
      return {
        ...entry,
        target: { kind: 'builtin' as const, id: 'node:path' },
      };
    });

    expect(
      compare(graph([{ ...root, imports: imported }]), graph([{ ...actual, imports: aliases }]))
        .comparison,
    ).toBe('equal');
    expect(compare(graph([root]), graph([{ ...actual, imports: aliases }])).reason).toBe('leaf');
  });

  it('compares exact raw Next source leaves within one declared root without proving those strings', () => {
    const body = 'const value=ctx.x("next/helper",()=>require("next/helper"));ctx.v(value);';
    function source(runtime: string, id: number, root: string, sha256 = 'a'.repeat(64)) {
      const own = row(runtime, id, body);
      const imports: NodeManifestHandlerImportData[] = own.imports.map((entry) => {
        return {
          ...entry,
          target: {
            kind: 'next-source',
            root,
            relative: 'dist/helper.js',
            file: `${root}/dist/helper.js`,
            sha256,
          },
        };
      });
      return graph([{ ...own, imports }], root);
    }
    const reference = source('ref', 1, '/fixed/next');

    expect(compare(reference, source('act', 9, '/current/next')).comparison).toBe('equal');

    const changed = source('act', 9, '/current/next', 'b'.repeat(64));

    expect(compare(reference, changed).reason).toBe('leaf');

    const wrong = source('act', 9, '/other/next');

    expect(compare(reference, { ...wrong, nextRoot: '/current/next' }).reason).toBe('leaf');
  });

  it('normalizes only the same explicitly enumerated literal path using exact materializations', () => {
    const input = slotFixture();
    const original = JSON.stringify(input);
    const value = compareNodeManifestHandlerGraphs(input);

    expect(value).toMatchObject({
      status: 'UNQUALIFIED',
      comparison: 'equal',
      counts: { slots: 1 },
    });
    expect(JSON.stringify(input)).toBe(original);

    const withoutSlots = compareNodeManifestHandlerGraphs({ ...input, literalSlots: undefined });

    expect(withoutSlots.comparison).toBe('different');
  });

  it.each([
    'missing',
    'extra',
    'duplicate-expected',
    'duplicate-actual',
    'wrong-value',
    'wrong-reference',
  ])('refuses %s slot data', (mode) => {
    expect(compareNodeManifestHandlerGraphs(changedSlots(mode))).toMatchObject({
      status: 'UNQUALIFIED',
      comparison: 'unsupported',
      reason: 'slots',
    });
  });

  it.each([
    ['callback', '__proto__', 'value'],
    ['callback', 'constructor', 'value'],
    ['callback', 'body', 'body', -1, 'value'],
    ['callback', 'body', 'body', '0', 'value'],
    ['callback', 'body', 'body', 0, 'expression', 'callee', 'value'],
    ['strictContext', 'value'],
    Array.from({ length: 130 }, () => 'value'),
  ])('rejects unsafe/nonliteral or remapped slot path %j', (...path) => {
    const input = slotFixture(),
      own = input.literalSlots?.expected[0];
    assert(own !== undefined, 'Expected authored slot');

    expect(
      compareNodeManifestHandlerGraphs({
        ...input,
        literalSlots: {
          expected: [{ ...own, path }],
          actual: [{ key: 'directory', value: '/ROOT/actual' }],
        },
      }).reason,
    ).toBe('slots');
  });

  it('does not normalize another equal-prefix literal or permit a directive slot', () => {
    const input = slotFixture();
    const changed = graph([row('act', 9, 'ctx.v("/ROOT/actual");ctx.v("/ROOT/unlisted");')]);

    expect(compareNodeManifestHandlerGraphs({ ...input, actual: changed }).comparison).toBe(
      'different',
    );

    const own = graph([row('ref', 1, '"use strict";ctx.v(42);')]);

    expect(
      compareNodeManifestHandlerGraphs({
        reference: own,
        actual: own,
        literalSlots: {
          expected: [
            {
              key: 'strict',
              row: own.root,
              path: ['callback', 'body', 'body', 0, 'expression', 'value'],
              referenceValue: 'use strict',
            },
          ],
          actual: [{ key: 'strict', value: 'use strict' }],
        },
      }).reason,
    ).toBe('slots');
  });

  it('declines unsupported operations and bounded malformed DATA without evaluating any body', () => {
    const own = graph([row('runtime', 1, 'ctx.v(42);')]),
      root = rootRow(own);

    expect(
      compare(own, replaceRow(own, 0, { operations: { ...root.operations, asyncLoads: [1] } }))
        .reason,
    ).toBe('unsupported-operation');
    expect(
      compare(own, replaceRow(own, 0, { whole: { ...root.whole, canonical: '{invalid' } })).reason,
    ).toBe('data');

    const huge = replaceRow(own, 0, { whole: { ...root.whole, canonical: 'x'.repeat(4_194_305) } });

    expect(compare(own, huge).reason).toBe('bounds');
    expect(compare(own, { ...own, rows: Array.from({ length: 257 }, () => root) }).reason).toBe(
      'bounds',
    );
  });

  it('compares independently authored reference fingerprints while requiring actual full DATA', () => {
    const authored = chain('reference', 1, 2, true);
    const reference: NodeManifestHandlerReferenceGraphData = {
      ...authored,
      rows: authored.rows.map((value) => fingerprint(value)),
    };
    const actual = chain('actual', 9, 10, true);

    expect(compareNodeManifestHandlerGraphs({ reference, actual })).toMatchObject({
      status: 'UNQUALIFIED',
      comparison: 'equal',
    });

    const bad = {
      ...reference,
      rows: reference.rows.map((value) => ({ ...value, canonicalSha256: '0'.repeat(64) })),
    };

    expect(compareNodeManifestHandlerGraphs({ reference: bad, actual }).comparison).toBe(
      'different',
    );

    const digestOnlyActual = Object.assign(chain('actual', 9, 10, true), { rows: reference.rows });

    expect(compareNodeManifestHandlerGraphs({ reference, actual: digestOnlyActual }).reason).toBe(
      'data',
    );
  });

  it('hashes only fully materialized actual slots using the documented static key token', () => {
    const input = slotFixture();
    const authored = rootRow(input.reference);
    const normalized = authored.whole.canonical.replace(jsLiteral('/ROOT/reference'), () =>
      JSON.stringify(nodeManifestHandlerLiteralToken('directory')),
    );
    const reference = { ...input.reference, rows: [fingerprint(authored, normalized)] };

    expect(compareNodeManifestHandlerGraphs({ ...input, reference }).comparison).toBe('equal');
    expect(
      compareNodeManifestHandlerGraphs({ ...input, reference, literalSlots: undefined }).comparison,
    ).toBe('different');
  });
});
