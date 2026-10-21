import { describe, expect, it } from 'vitest';

import { parseStoredManifest } from '../src/manifest/stored.ts';
import {
  baseline,
  capturedRead,
  compactGraph,
  outcome,
  withInheritedField,
  type CompactGraph,
  type RouteGraph,
} from './stored-manifest-fixtures.ts';

describe('owned JSON restoration keeps prototype keys as data', () => {
  it('retains hostile dictionary keys without changing any prototype', () => {
    const json =
      '{"schemaVersion":6,"tables":{"headers":[{"__proto__":"ordinary","constructor":"header"}]},"routes":{"__proto__":{"headers":0},"constructor":{"headers":0},"prototype":{"headers":0}}}';
    const before = Object.getOwnPropertyNames(Object.prototype);
    const restored = parseStoredManifest(json) as RouteGraph;

    expect(restored).toStrictEqual(baseline(json));
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(restored.routes)).toBe(Object.prototype);
    expect(Object.keys(restored.routes)).toStrictEqual(['__proto__', 'constructor', 'prototype']);
    expect(Object.hasOwn(restored.routes, '__proto__')).toBe(true);
    expect(restored.routes['__proto__']?.headers).toHaveProperty('__proto__', 'ordinary');
    expect(Object.getOwnPropertyNames(Object.prototype)).toStrictEqual(before);
  });

  it('keeps native last-value behavior for duplicate JSON names', () => {
    const json =
      '{"schemaVersion":5,"schemaVersion":6,"tables":{"headers":[{}]},"routes":{"__proto__":{"headers":8},"__proto__":{"headers":0}}}';

    expect(parseStoredManifest(json)).toStrictEqual(baseline(json));
    expect(parseStoredManifest(json)).toHaveProperty(['routes', '__proto__', 'headers'], {});
  });
});

describe('an inherited restoration field selects the unchanged nonmutating reader', () => {
  it.each([
    'tables',
    'schemaVersion',
    'routes',
    'dynamicRoutes',
    'members',
    'headers',
    'conditions',
    'preloads',
    'bypassFor',
  ])('keeps even an inherited undefined %s off the mutable path', (name) => {
    const json = JSON.stringify(compactGraph());
    const read = withInheritedField(name, { value: undefined, writable: true }, () =>
      capturedRead(json),
    );
    const parsed = read.parsed as CompactGraph;
    const restored = read.value as RouteGraph;

    expect(read.argumentCounts).toStrictEqual([1]);
    expect(restored).toStrictEqual(baseline(json));
    expect(restored.routes).not.toBe(parsed.routes);
    expect(parsed.routes['/first']?.headers).toBe(0);
  });

  it('does not mutate a foreign inherited routes container', () => {
    const foreign = { '/foreign': { headers: 0 } };
    const json = JSON.stringify({ schemaVersion: 6, tables: compactGraph().tables });
    const answers = withInheritedField('routes', { value: foreign, writable: true }, () => {
      return { old: outcome(baseline, json), owned: outcome(parseStoredManifest, json) };
    });

    expect(answers.owned).toStrictEqual(answers.old);
    expect(foreign).toStrictEqual({ '/foreign': { headers: 0 } });
  });

  it('does not mutate a foreign inherited dynamic array or member record', () => {
    const foreign = [{ members: { bypassFor: 0 } }];
    const json = JSON.stringify({
      schemaVersion: 6,
      tables: compactGraph().tables,
      routes: { '/a': { headers: 0 } },
    });
    const answers = withInheritedField('dynamicRoutes', { value: foreign, writable: true }, () => {
      return { old: outcome(baseline, json), owned: outcome(parseStoredManifest, json) };
    });

    expect(answers.owned).toStrictEqual(answers.old);
    expect(foreign).toStrictEqual([{ members: { bypassFor: 0 } }]);
  });

  it('does not mutate a foreign member inherited by an owned dynamic route', () => {
    const foreign = { bypassFor: 0 };
    const json = JSON.stringify({
      schemaVersion: 6,
      tables: compactGraph().tables,
      routes: { '/a': { headers: 0 } },
      dynamicRoutes: [{}],
    });
    const answers = withInheritedField('members', { value: foreign, writable: true }, () => {
      return { old: outcome(baseline, json), owned: outcome(parseStoredManifest, json) };
    });

    expect(answers.owned).toStrictEqual(answers.old);
    expect(foreign).toStrictEqual({ bypassFor: 0 });
  });

  it('does not invoke an inherited getter before the generic reader or call its setter', () => {
    const json = JSON.stringify({
      schemaVersion: 6,
      tables: compactGraph().tables,
      routes: { '/a': { headers: 0 } },
    });
    const calls: string[] = [];
    const answers = withInheritedField(
      'bypassFor',
      {
        get: () => {
          calls.push('get');
          return 0;
        },
        set: () => {
          calls.push('set');
        },
      },
      () => {
        const old = outcome(baseline, json);
        const oldCalls = [...calls];
        calls.length = 0;
        const owned = outcome(parseStoredManifest, json);
        return { old, owned, oldCalls, ownedCalls: [...calls] };
      },
    );

    expect(answers.owned).toStrictEqual(answers.old);
    expect(answers.ownedCalls).toStrictEqual(answers.oldCalls);
    expect(answers.ownedCalls).toStrictEqual(['get', 'get']);
  });

  it('preserves an inherited getter failure before returning any graph', () => {
    const json = JSON.stringify({
      schemaVersion: 6,
      tables: compactGraph().tables,
      routes: { '/a': {} },
    });
    let reads = 0;
    const answers = withInheritedField(
      'headers',
      {
        get: () => {
          reads += 1;
          throw new Error('foreign header');
        },
      },
      () => {
        return { old: outcome(baseline, json), owned: outcome(parseStoredManifest, json) };
      },
    );

    expect(answers.owned).toStrictEqual(answers.old);
    expect(answers.owned).toStrictEqual({ error: { name: 'Error', message: 'foreign header' } });
    expect(reads).toBe(2);
  });
});
