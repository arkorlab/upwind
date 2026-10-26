import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';

import * as consumers from '../src/node-manifest-graph.ts';
import type { ManifestModuleGraph, ManifestRouteSource } from '../src/node-manifest-graph.ts';
import type { NodeManifestNormalization } from '../src/node-manifest-normalization.ts';
import { proveNodeManifests } from '../src/node-manifest-proof.ts';
import {
  checkedNodeRouteRewriteSources,
  combineNodeRouteRewriteApprovals,
  completedNodeRouteRewriteApproval,
  type NodeRouteRewriteApprovalBinding,
} from '../src/node-route-rewrite-approval.ts';

function fixture() {
  const entries = [{ id: '/page', filePath: '/authored/.next/page.js' }];
  const context = { distDir: '/authored/.next', entries };
  const graph = {
    sources: new Map([['source', { file: '/authored/source.js', sha256: 'source-pin' }]]),
    importers: new Map([['source', [] as string[]]]),
    retained: new Set(['source']),
    rendered: new Map([['source', 'const authored=1;']]),
  };
  function normalization(file = '/authored/metadata.json'): NodeManifestNormalization {
    return {
      entries: entries.map((entry) => ({ ...entry, canonicalFilePath: entry.filePath })),
      distDir: context.distDir,
      canonicalDistDir: context.distDir,
      runtimeRootDir: '/authored',
      metadataFiles: [{ file, sha256: 'metadata-pin' }],
    };
  }
  function binding(
    normalized = normalization(),
    routes: readonly ManifestRouteSource[] = [],
  ): NodeRouteRewriteApprovalBinding {
    return {
      normalization: normalized,
      approval: completedNodeRouteRewriteApproval({
        graph,
        context,
        normalization: normalized,
        routes,
      }),
    };
  }
  function combine(bindings: readonly NodeRouteRewriteApprovalBinding[]) {
    return combineNodeRouteRewriteApprovals({ bindings, graph, context });
  }
  function checked(result: ReturnType<typeof combine>) {
    return checkedNodeRouteRewriteSources({ ...result, graph, context });
  }
  return { graph, context, normalization, binding, combine, checked };
}
function route(file: string): ManifestRouteSource {
  return {
    file,
    sha256: 'route-pin',
    root: '/authored/next',
    relative: file.split('/').at(-1) ?? '',
  };
}

describe('completed evaluator route approval normalization', () => {
  it('reproduces the last-normalization mismatch and combines both original approvals', () => {
    const own = fixture();
    const first = own.binding(own.normalization('/authored/first.json'), [route('/authored/a.js')]);
    const second = own.binding(own.normalization('/authored/second.json'), [
      route('/authored/b.js'),
    ]);

    expect(() => {
      return own.checked({
        approvals: [first.approval, second.approval],
        normalization: second.normalization,
      });
    }).toThrow('stale completed route graph');

    const combined = own.combine([first, second]);

    expect(combined.approvals).toHaveLength(1);
    expect(combined.normalization).not.toBe(first.normalization);
    expect(combined.normalization).not.toBe(second.normalization);
    expect(combined.normalization?.metadataFiles?.map((source) => source.file)).toStrictEqual([
      '/authored/first.json',
      '/authored/second.json',
    ]);
    expect(own.checked(combined)).toStrictEqual([route('/authored/a.js'), route('/authored/b.js')]);
    expect(Object.isFrozen(combined.normalization?.entries)).toBe(true);
    expect(Object.isFrozen(combined.normalization?.metadataFiles)).toBe(true);
  });

  it('preserves zero behavior and the original single normalization and approval instances', () => {
    const own = fixture();
    const one = own.binding();
    const empty = own.combine([]);
    const single = own.combine([one]);

    expect(empty).toStrictEqual({ approvals: [], normalization: undefined });
    expect(single.normalization).toBe(one.normalization);
    expect(single.approvals[0]).toBe(one.approval);
    expect(own.checked(single)).toStrictEqual([]);
  });

  it.each(['distDir', 'canonicalDistDir', 'runtimeRootDir', 'entries'] as const)(
    'refuses individually completed approvals with different common %s scope',
    (field) => {
      const own = fixture();
      const first = own.binding();
      const normalized = own.normalization();
      const value = field === 'entries' ? [] : '/authored/other';
      Reflect.set(normalized, field, value);
      const second = own.binding(normalized);

      expect(() => own.combine([first, second])).toThrow('stale completed route graph');
    },
  );

  it.each(['id', 'filePath', 'canonicalFilePath'] as const)(
    'refuses a mismatched ordered entry %s instead of structurally authorizing it',
    (field) => {
      const own = fixture();
      const normalized = own.normalization();
      Reflect.set(normalized.entries[0] ?? {}, field, 'changed');

      expect(() => own.combine([own.binding(), own.binding(normalized)])).toThrow(
        'stale completed route graph',
      );
    },
  );

  it('refuses defined versus missing runtime roots and conflicting metadata pins', () => {
    const own = fixture();
    const absent = own.normalization();
    Reflect.deleteProperty(absent, 'runtimeRootDir');
    const conflicting = own.normalization();
    Reflect.set(conflicting.metadataFiles?.[0] ?? {}, 'sha256', 'conflict');

    expect(() => own.combine([own.binding(), own.binding(absent)])).toThrow('stale completed');
    expect(() => own.combine([own.binding(), own.binding(conflicting)])).toThrow('stale completed');
  });

  it('requires the same complete ordered SDK entry inventory', () => {
    const own = fixture();
    own.context.entries.push({ id: '/other', filePath: '/authored/.next/other.js' });
    const first = own.binding();
    const normalized = own.normalization();
    Reflect.set(normalized, 'entries', normalized.entries.toReversed());

    expect(() => own.combine([first, own.binding(normalized)])).toThrow('stale completed');
  });

  it.each(['sha256', 'root', 'relative'] as const)(
    'refuses conflicting route %s evidence',
    (field) => {
      const own = fixture();
      const first = route('/authored/a.js');
      const other = { ...first, [field]: 'conflict' };

      expect(() =>
        own.combine([own.binding(undefined, [first]), own.binding(undefined, [other])]),
      ).toThrow('stale completed route graph');
    },
  );

  it('deduplicates consistent metadata and routes only after authenticating original tokens', () => {
    const own = fixture();
    const normalized = own.normalization();
    const first = own.binding(normalized, [route('/authored/a.js')]);
    const second = own.binding(own.normalization(), [route('/authored/a.js')]);
    const combined = own.combine([first, second]);

    expect(combined.normalization?.metadataFiles).toHaveLength(1);
    expect(own.checked(combined)).toStrictEqual([route('/authored/a.js')]);
    expect(() => own.combine([{ ...first, approval: { ...first.approval } }, second])).toThrow(
      'stale completed route graph',
    );
    expect(() => own.combine([first, { ...first, normalization: { ...normalized } }])).toThrow(
      'stale completed route graph',
    );
    expect(() => {
      return combineNodeRouteRewriteApprovals({
        bindings: [first, second],
        graph: { ...own.graph },
        context: own.context,
      });
    }).toThrow('stale completed route graph');
  });

  it('rejects stale graph, context and original normalization before combining', () => {
    const own = fixture();
    const first = own.binding();
    const second = own.binding();
    const entry = own.context.entries[0];
    assert(entry !== undefined);

    own.graph.retained.add('unproved');

    expect(() => own.combine([first, second])).toThrow('stale completed route graph');

    own.graph.retained.delete('unproved');
    entry.id = '/changed';

    expect(() => own.combine([first, second])).toThrow('stale completed route graph');

    entry.id = '/page';
    Reflect.set(second.normalization.metadataFiles?.[0] ?? {}, 'sha256', 'changed');

    expect(() => own.combine([first, second])).toThrow('stale completed route graph');
  });

  it('keeps every private original dependency fresh after final approval and pair wrapper changes', () => {
    const own = fixture();
    const first = own.binding(own.normalization('/authored/first.json'));
    const second = own.binding(own.normalization('/authored/second.json'));
    const pairs = [{ ...first }, { ...second }];
    const combined = own.combine(pairs);
    const pair = pairs[1];
    const finalNormalization = combined.normalization;
    assert(pair !== undefined && finalNormalization !== undefined);
    pair.approval = first.approval;
    pair.normalization = first.normalization;

    expect(own.checked(combined)).toStrictEqual([]);

    Reflect.set(second.normalization.metadataFiles?.[0] ?? {}, 'sha256', 'changed');

    expect(() => own.checked(combined)).toThrow('stale completed route graph');

    Reflect.set(second.normalization.metadataFiles?.[0] ?? {}, 'sha256', 'metadata-pin');

    expect(own.checked(combined)).toStrictEqual([]);
    expect(() => own.checked({ ...combined, normalization: { ...finalNormalization } })).toThrow(
      'stale completed route graph',
    );
  });

  it('captures a caller getter pair once before authenticating or merging its normalization', () => {
    const own = fixture();
    const first = own.binding(own.normalization('/authored/first.json'));
    const second = own.binding(own.normalization('/authored/approved.json'));
    const unapproved = own.normalization('/authored/unapproved.json');
    let reads = 0;
    const changing = {
      approval: second.approval,
      get normalization() {
        reads += 1;
        return reads === 3 ? unapproved : second.normalization;
      },
    };
    const combined = own.combine([first, changing]);

    expect(reads).toBe(1);
    expect(combined.normalization?.metadataFiles?.map((source) => source.file)).toStrictEqual([
      '/authored/first.json',
      '/authored/approved.json',
    ]);
    expect(own.checked(combined)).toStrictEqual([]);
    expect(reads).toBe(1);
  });

  it('validates shared original dependencies in a nested private DAG without rebinding them', () => {
    const own = fixture();
    const first = own.binding();
    const inner = own.combine([first, own.binding()]);
    const approval = inner.approvals[0];
    const normalization = inner.normalization;
    assert(approval !== undefined && normalization !== undefined);
    const final = own.combine([{ approval, normalization }, first]);

    expect(own.checked(final)).toStrictEqual([]);
    expect(() => own.combine([{ approval, normalization: { ...normalization } }, first])).toThrow(
      'stale completed route graph',
    );
  });
});

describe('multiple evaluator source aggregation', () => {
  let directory: string;

  beforeEach(async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'upwind-evaluator-approvals-'));
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('returns one final approval for two independent mocked consumer proofs over pinned raw source', async () => {
    const bytes = await readFile(
      new URL(import.meta.resolve('next/dist/server/load-manifest.external.js')),
    );
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sources = new Map<string, { file: string; sha256: string }>();
    for (const name of ['first', 'second']) {
      const root = path.join(directory, name);
      const file = path.join(root, 'dist/server/load-manifest.external.js');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      await writeFile(path.join(root, 'package.json'), '{"name":"next","version":"16.4.3"}');
      sources.set(name, { file, sha256 });
    }
    const graph: ManifestModuleGraph = {
      sources,
      importers: new Map(),
      retained: new Set(sources.keys()),
    };
    const input = { distDir: directory, manifests: [] };
    const normals: NodeManifestNormalization[] = [];
    const mocked = vi
      .spyOn(consumers, 'proveManifestConsumerGraph')
      .mockImplementation((_input, actual, evaluator) => {
        const normalization: NodeManifestNormalization = {
          entries: [],
          distDir: directory,
          canonicalDistDir: directory,
          metadataFiles: [
            { file: path.join(directory, `${evaluator.id}.json`), sha256: 'authored' },
          ],
        };
        normals.push(normalization);
        return Promise.resolve({
          normalization,
          files: [],
          pages: [],
          approvedCompilerSources: [],
          approvedRouteSources: [],
          metadataFiles: normalization.metadataFiles ?? [],
          routeRewriteApproval: completedNodeRouteRewriteApproval({
            graph: actual,
            context: input,
            normalization,
            routes: [],
          }),
        });
      });
    const result = await proveNodeManifests(input, graph);

    expect(mocked).toHaveBeenCalledTimes(2);
    expect(normals[0]).not.toBe(normals[1]);
    expect(result.routeRewriteApprovals).toHaveLength(1);
    expect(result.normalization?.metadataFiles).toHaveLength(2);
    expect(
      checkedNodeRouteRewriteSources({
        graph,
        context: input,
        approvals: result.routeRewriteApprovals,
        normalization: result.normalization,
      }),
    ).toStrictEqual([]);
  });
});
