import { describe, expect, it } from 'vitest';

import { MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY } from '../src/cache/keys.ts';
import { packHeaderOf } from '../src/cache/pack-header.ts';
import {
  cachePolicySchema,
  type GenerationPackHeader,
  generationPackHeaderSchema,
  generationTagSchema,
  invalidationStateSchema,
  packArtifactRefSchema,
} from '../src/cache/schema.ts';

/**
 * The runtime checks a delivery record's header by hand (`packHeaderOf`) so that it needs no schema
 * library to start, and the schema is still the contract: every host, and the edge, reads the same
 * record. So the two are held to the same answer — the same verdict on every header below, and the
 * same header handed back, key for key and in the same order — and to the same fields, so that a
 * field the schema gains is a failure here rather than a record the two read differently.
 */

/** 2026-09-20T00:00:00Z */
const T0 = 1_789_862_400_000;
const HEX = 'ab'.repeat(32);
const SIXTY = 60;
/** Stands for a number JSON reads as infinite (`1e999`), which `JSON.stringify` cannot write. */
const INFINITE = '__infinite__';

/** A header with every field there is, the optional ones included. */
const FULL = {
  schemaVersion: 1,
  scopeId: 'dpl_4Fixture2Minima1AppXy',
  entryId: 'ent_1',
  generationId: 'gen_1',
  seq: 3,
  source: 'runtime',
  staticPagePrivacy: 1,
  kind: 'app-page',
  route: '/items/[id]',
  pathname: '/items/1',
  cacheTimestamp: T0,
  producedAt: T0 + 1,
  policy: {
    revalidateAfter: { kind: 'finite', seconds: SIXTY },
    expireAfter: { kind: 'unbounded' },
    clientStale: { kind: 'unknown' },
    source: 'runtime-output',
  },
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', 'x-a': 'b' },
  tags: [
    { kind: 'next-implicit', value: '_N_T_/layout' },
    { kind: 'next-explicit', value: 'product' },
  ],
  htmlSha256: HEX,
  htmlLength: 10,
  postponedSha256: HEX,
  postponedLength: 2,
  artifacts: [
    {
      artifactId: 'blob_1',
      sha256: HEX,
      byteLength: 5,
      contentType: 'text/x-component',
      encoding: 'identity',
      role: 'rsc',
      representationKey: 'rsc',
      storageRef: 'cache/dpl_1/blobs/ab',
    },
  ],
  revision: 4,
  invalidation: { revision: 4, staleAt: T0 + 2, hardExpireAt: T0 + 3 },
} as const;

/** The least a header may be: nothing optional, nothing postponed, nothing in the lists. */
const BARE = {
  ...FULL,
  source: 'build',
  staticPagePrivacy: undefined,
  cacheTimestamp: null,
  producedAt: null,
  headers: {},
  tags: [],
  postponedSha256: null,
  postponedLength: 0,
  artifacts: [],
  invalidation: undefined,
};

/**
 * Every timing of the policy finite, the variant the two others never are: each `seconds` there is
 * one to check, and each `kind` one to change from it.
 */
const FINITE = {
  ...FULL,
  policy: {
    revalidateAfter: { kind: 'finite', seconds: SIXTY },
    expireAfter: { kind: 'finite', seconds: 2 * SIXTY },
    clientStale: { kind: 'finite', seconds: SIXTY / 2 },
    source: 'runtime-output',
  },
} as const;

/** Where one value of a header can be changed, as a path of keys and indices. */
const PATHS: readonly (readonly (string | number)[])[] = [
  ...Object.keys(FULL).map((key) => [key]),
  ['policy', 'revalidateAfter'],
  ['policy', 'revalidateAfter', 'kind'],
  ['policy', 'revalidateAfter', 'seconds'],
  ['policy', 'expireAfter'],
  ['policy', 'expireAfter', 'kind'],
  ['policy', 'expireAfter', 'seconds'],
  ['policy', 'clientStale'],
  ['policy', 'clientStale', 'kind'],
  ['policy', 'clientStale', 'seconds'],
  ['policy', 'source'],
  ['policy', 'extra'],
  ['headers', 'x-a'],
  ['headers', 'x-new'],
  ['tags', 0],
  ['tags', 0, 'kind'],
  ['tags', 0, 'value'],
  ['tags', 0, 'extra'],
  ...Object.keys(FULL.artifacts[0]).map((key) => ['artifacts', 0, key]),
  ['artifacts', 0],
  ['invalidation', 'revision'],
  ['invalidation', 'staleAt'],
  ['invalidation', 'hardExpireAt'],
  ['extra'],
];

/** What each of those is set to in turn: every kind of JSON value, and the edges of each check. */
const VALUES: readonly unknown[] = [
  undefined,
  null,
  true,
  0,
  -0,
  1,
  2,
  -1,
  1.5,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  INFINITE,
  '',
  'x',
  '/',
  '/x',
  'a'.repeat(MAX_TAG_LENGTH),
  'a'.repeat(MAX_TAG_LENGTH + 1),
  HEX,
  HEX.toUpperCase(),
  `${HEX}0`,
  [],
  [{}],
  {},
  { kind: 'finite', seconds: 0 },
  { kind: 'finite', seconds: -1 },
  { kind: 'finite', seconds: 1.5 },
  { kind: 'finite' },
  { kind: 'unbounded' },
  { kind: 'unknown' },
  { kind: 'never' },
  'finite',
  'unbounded',
  'unknown',
  'build',
  'runtime',
  'pages',
  'app-route',
  'data:fetch',
  'next-explicit',
  'platform-delivery',
  'html',
  'gzip',
  'postponed',
  'build-output',
  'legacy-unknown',
];

/** `header` with the value at `path` set to `value` — or taken out, for `undefined`. */
function changed(header: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const copy = structuredClone(header) as Record<string | number, unknown>;
  const above = path.slice(0, -1);
  let parent: Record<string | number, unknown> = copy;
  for (const key of above) {
    const next = parent[key];
    if (typeof next !== 'object' || next === null) {
      return copy;
    }
    parent = next as Record<string | number, unknown>;
  }
  const last = path.at(-1);
  if (last === undefined) {
    return copy;
  }
  if (value === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the variant is a header without that field
    delete parent[last];
  } else {
    parent[last] = value;
  }
  return copy;
}

/** The header as the reader has it: written out as JSON and read back. */
function asRead(header: unknown): unknown {
  const text = JSON.stringify(header).replaceAll(`"${INFINITE}"`, '1e999');
  return JSON.parse(text) as unknown;
}

function bySchema(value: unknown): GenerationPackHeader | undefined {
  const parsed = generationPackHeaderSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The header as text that tells every difference apart: its values, the order of its keys, and a
 * key that is there with nothing in it from one that is not there.
 */
function spelled(header: GenerationPackHeader | null = null): string {
  return JSON.stringify(header, (_key, value: unknown) =>
    value === undefined ? '(undefined)' : value,
  );
}

/** Whether the two answer alike: the verdict, and the header each hands back. */
function agree(value: unknown): boolean {
  return spelled(packHeaderOf(value)) === spelled(bySchema(value));
}

function expectAgreement(value: unknown): void {
  expect(packHeaderOf(value)).toStrictEqual(bySchema(value));
  expect(agree(value)).toBe(true);
}

function variants(): { name: string; value: unknown }[] {
  const out: { name: string; value: unknown }[] = [];
  for (const [label, base] of [
    ['full', FULL],
    ['bare', BARE],
    ['finite', FINITE],
  ] as const) {
    for (const path of PATHS) {
      for (const value of VALUES) {
        out.push({
          name: `${label} ${path.join('.')} = ${value === undefined ? 'absent' : JSON.stringify(value)}`,
          value: asRead(changed(base, path, value)),
        });
      }
    }
  }
  return out;
}

describe('the header of a delivery record, checked by hand', () => {
  it('takes the three headers the tests start from, as the schema does', () => {
    expect(packHeaderOf(asRead(FULL))).toBeDefined();
    expect(packHeaderOf(asRead(BARE))).toBeDefined();
    expect(packHeaderOf(asRead(BARE))).not.toHaveProperty('staticPagePrivacy');
    expect(packHeaderOf(asRead(FINITE))).toBeDefined();

    expectAgreement(asRead(FULL));
    expectAgreement(asRead(BARE));
    expectAgreement(asRead(FINITE));
  });

  it('accepts legacy packs without an internal storage locator', () => {
    const artifact = { ...FULL.artifacts[0] };
    Reflect.deleteProperty(artifact, 'storageRef');
    const legacy = { ...FULL, artifacts: [artifact] };
    expectAgreement(legacy);

    expect(packHeaderOf(legacy)?.artifacts[0]).not.toHaveProperty('storageRef');
  });

  it('agrees with the schema on every header one value away from them', () => {
    const cases = variants();
    const refused = cases.filter((one) => bySchema(one.value) === undefined);

    // Most of these are refusals, and some are not: both kinds of answer are being compared.
    expect(refused.length).toBeGreaterThan(cases.length / 2);
    expect(refused.length).toBeLessThan(cases.length);
    expect(cases.filter((one) => !agree(one.value)).map((one) => one.name)).toStrictEqual([]);
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"header"'],
    ['a number', '1'],
    ['another version', JSON.stringify({ ...FULL, schemaVersion: 3 })],
  ])('refuses %s, as the schema does', (_label, text) => {
    expectAgreement(JSON.parse(text) as unknown);

    expect(packHeaderOf(JSON.parse(text) as unknown)).toBeUndefined();
  });

  /**
   * JSON makes `__proto__` a key like any other, which the schema's record type passes over rather
   * than copy — whatever it holds — and which an object type drops as a key it does not name.
   */
  it('passes over `__proto__` where the schema does', () => {
    const inHeaders = JSON.stringify(FULL).replace('"x-a":"b"', '"x-a":"b","__proto__":5');
    const atTop = JSON.stringify(FULL).replace(
      '{"schemaVersion"',
      '{"__proto__":{"seq":0},"schemaVersion"',
    );

    expectAgreement(JSON.parse(inHeaders) as unknown);
    expectAgreement(JSON.parse(atTop) as unknown);

    expect(packHeaderOf(JSON.parse(inHeaders) as unknown)?.headers).toStrictEqual(FULL.headers);
  });

  it('takes as many tags as a record may carry, and no more', () => {
    const tag = { kind: 'next-explicit', value: 'product' };
    const most = { ...FULL, tags: Array.from({ length: MAX_TAGS_PER_ENTRY }, () => tag) };
    const tooMany = { ...FULL, tags: Array.from({ length: MAX_TAGS_PER_ENTRY + 1 }, () => tag) };

    expectAgreement(asRead(most));
    expectAgreement(asRead(tooMany));

    expect(packHeaderOf(asRead(tooMany))).toBeUndefined();
  });

  /**
   * A field the schema gains has to be read here too, or a record that carries it is read one way
   * by a host and another by the runtime: the full header names every field, the optional ones
   * among them, so a field the schema names and the header lacks is a field `packHeaderOf` does not
   * read yet.
   */
  it('reads every field the schema names', () => {
    const full = packHeaderOf(asRead(FULL));

    expect(Object.keys(full ?? {})).toStrictEqual(Object.keys(generationPackHeaderSchema.shape));
    expect(Object.keys(full?.policy ?? {})).toStrictEqual(Object.keys(cachePolicySchema.shape));
    expect(Object.keys(full?.tags[0] ?? {})).toStrictEqual(Object.keys(generationTagSchema.shape));
    expect(Object.keys(full?.artifacts[0] ?? {})).toStrictEqual(
      Object.keys(packArtifactRefSchema.shape),
    );
    expect(Object.keys(full?.invalidation ?? {})).toStrictEqual(
      Object.keys(invalidationStateSchema.shape),
    );
  });
});
