import { vi } from 'vitest';

import { buildProjectManifest } from '../src/manifest/manifest.ts';
import type { ProjectManifest } from '../src/manifest/schema.ts';
import { fromStoredManifest, parseStoredManifest } from '../src/manifest/stored.ts';

export interface RouteGraph {
  readonly routes: Record<string, { headers: unknown; bypassFor?: unknown; preloads?: unknown }>;
  readonly dynamicRoutes: { readonly members?: { bypassFor?: unknown } }[];
}

export interface CompactGraph extends RouteGraph {
  schemaVersion: number;
  readonly tables: { headers: unknown[]; conditions: unknown[]; preloads: unknown[] };
}

/** Distinct table indices can hold equal values; only a shared index establishes shared identity. */
export function compactGraph(): CompactGraph {
  return {
    schemaVersion: 6,
    tables: {
      headers: [{ 'x-policy': 'shared' }, { 'x-policy': 'shared' }],
      conditions: [[{ type: 'header', key: 'x-preview' }]],
      preloads: [['</app.css>; rel=preload; as=style']],
    },
    routes: {
      '/first': { headers: 0, bypassFor: 0, preloads: 0 },
      '/second': { headers: 0, bypassFor: 0, preloads: 0 },
      '/equal': { headers: 1 },
    },
    dynamicRoutes: [{ members: { bypassFor: 0 } }, { members: {} }, {}],
  };
}

export function baseline(json: string): unknown {
  const parsed: unknown = JSON.parse(json);
  return fromStoredManifest(parsed);
}

type Outcome = { readonly value: unknown } | { readonly error: { name: string; message: string } };

/** Error stacks depend on their call site; refusal types and messages are part of this contract. */
export function outcome(read: (json: string) => unknown, json: string): Outcome {
  try {
    return { value: read(json) };
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return { error: { name: error.name, message: error.message } };
  }
}

/** A passive CI observer of the native parser's fresh result, restored before any assertion. */
export function capturedRead(json: string): {
  readonly parsed: unknown;
  readonly value: unknown;
  readonly argumentCounts: number[];
} {
  const nativeParse = JSON.parse;
  let parsed: unknown;
  const observer = vi.spyOn(JSON, 'parse').mockImplementation((text: string) => {
    parsed = nativeParse(text);
    return parsed;
  });
  try {
    const value = parseStoredManifest(json);
    return {
      parsed,
      value,
      argumentCounts: observer.mock.calls.map((args) => args.length),
    };
  } finally {
    observer.mockRestore();
  }
}

export function freezeGraph(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeGraph(child);
  }
}

/** A deliberate inherited-field fixture; no assertions or asynchronous work run while installed. */
export function withInheritedField<T>(
  name: string,
  descriptor: PropertyDescriptor,
  read: () => T,
): T {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
  try {
    // eslint-disable-next-line no-extend-native -- exercise the reader's inherited-field fallback and restore the exact descriptor in finally
    Object.defineProperty(Object.prototype, name, { ...descriptor, configurable: true });
    return read();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(Object.prototype, name);
    } else {
      // eslint-disable-next-line no-extend-native -- restore the native prototype's pre-test descriptor
      Object.defineProperty(Object.prototype, name, previous);
    }
  }
}

export function publishedManifest(): ProjectManifest {
  return buildProjectManifest({
    projectId: 'project',
    runId: 'run',
    generatedAt: '2026-10-22T00:00:00.000Z',
    originHost: 'app.example',
    deployment: { assetSetHash: 'assets', observedAt: '2026-10-22T00:00:00.000Z' },
    app: { deploymentId: 'deployment', scriptName: 'app' },
    routes: ['/first', '/second'].map((pathname) => {
      return {
        pathname,
        status: 200 as const,
        shell: {
          sha256: 'a'.repeat(64),
          byteLength: 10,
          contentType: 'text/html',
          encoding: 'identity' as const,
        },
        headers: { 'x-policy': 'shared' },
        bypassFor: [{ type: 'header' as const, key: 'x-preview' }],
        preloads: ['</app.css>; rel=preload; as=style'],
      };
    }),
    dynamicRoutes: [
      {
        sourceRegex: '^/items/([^/]+)$',
        members: {
          route: '/items/[slug]',
          kind: 'app-page',
          bypassFor: [{ type: 'header', key: 'x-preview' }],
        },
      },
    ],
  });
}
