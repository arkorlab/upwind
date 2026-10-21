import { createId } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';

import { edgeTag } from '../../src/deploy/edge-version.ts';
import { functionScriptName, projectNames } from '../../src/deploy/names.ts';
import type { FakeCloudflare, FakeScript, FakeVersion } from './fake-cloudflare.ts';

/**
 * A project's edge on the fake account, as deploys left it: each deployment's edge version tagged
 * and bound to its pointer, its Functions beside it, and the edge's traffic where a test says —
 * and the edge itself, answering its readiness path as the version Cloudflare would route to.
 */

export const NAMES = projectNames('shop');
/** Long enough ago for a Function no edge version names to be taken for a stopped run's. */
export const LONG_AGO = '2026-01-01T00:00:00.000Z';
const HEX = 16;
const MANIFEST_DIGITS = 64;
const FULL = 100;

export interface Deployed {
  readonly deploymentId: string;
  readonly versionId: string;
  readonly manifestId: string;
  readonly scriptName: string;
}

export interface FakeEdge {
  readonly script: FakeScript;
  /** Upload a deployment's edge version, newest first, and its Function unless told not to. */
  deploy(input?: { readonly functions?: boolean; readonly createdOn?: string }): Deployed;
  /**
   * Upload another version of the edge for a deployment there already, as a rollback publishing it
   * again does: a pointer of its own, to a manifest of its own, and the deployment's Functions.
   */
  redeploy(deployed: Deployed): Deployed;
  /** A version of no deployment's, as another upload of the edge would leave. */
  upload(): void;
  /** Give the edge's traffic as said. */
  serve(shares: readonly { readonly versionId: string; readonly percentage: number }[]): void;
  /**
   * What the account's network answers: the API as the fake does, and the edge's `workers.dev`
   * name as the version Cloudflare routes a request to — the one a request names where the edge's
   * deployment holds it, and otherwise the one that takes all the traffic.
   */
  fetch(failing?: ReadonlySet<string>): typeof fetch;
}

export function scriptOf(name: string, createdOn?: string): FakeScript {
  return {
    name,
    versions: [],
    deployments: [],
    subdomain: { enabled: false, previews_enabled: false },
    migrationTag: undefined,
    secrets: new Map(),
    ...(createdOn !== undefined && { createdOn }),
  };
}

function pointerOf(version: FakeVersion | undefined): Record<string, unknown> | undefined {
  const bindings = (version?.metadata['bindings'] ?? []) as readonly {
    readonly name: string;
    readonly text?: string;
  }[];
  const text = bindings.find((binding) => binding.name === 'POINTER')?.text;
  return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>);
}

export function fakeEdge(fake: FakeCloudflare): FakeEdge {
  const edge = scriptOf(NAMES.edge);
  fake.scripts.set(NAMES.edge, edge);
  let count = 0;
  /** A version of the edge for the deployment, with a manifest of its own, uploaded newest. */
  const upload = (deploymentId: string, scriptName: string): Deployed => {
    count += 1;
    const manifestId = count.toString(HEX).padStart(MANIFEST_DIGITS, '0');
    const pointer = JSON.stringify({
      v: 1,
      projectId: NAMES.project,
      originHost: `${NAMES.edge}.example.workers.dev`,
      mode: 'edge',
      manifestId,
      policyId: DEFAULT_DELIVERY_POLICY.id,
      selectedPolicy: 'builtin',
      app: { deploymentId, scriptName },
      updatedAt: LONG_AGO,
    });
    const versionId = `version-edge-${String(count)}`;
    edge.versions.unshift({
      id: versionId,
      number: edge.versions.length + 1,
      metadata: { bindings: [{ type: 'plain_text', name: 'POINTER', text: pointer }] },
      modules: ['index.mjs'],
      annotations: {
        'workers/tag': edgeTag(deploymentId, pointer),
        'workers/message': `upwind deploy ${deploymentId}`,
      },
    });
    return { deploymentId, versionId, manifestId, scriptName };
  };
  const routed = (request: Request): FakeVersion | undefined => {
    const shares = edge.deployments[0]?.versions ?? [];
    // `<worker>="<version>"`: the version is between the quotes.
    const named = request.headers.get('cloudflare-workers-version-overrides') ?? '';
    const asked = named.slice(named.indexOf('"') + 1, named.lastIndexOf('"'));
    const held = shares.some((share) => share.version_id === asked);
    const versionId = held ? asked : shares.find((share) => share.percentage === FULL)?.version_id;
    return edge.versions.find((version) => version.id === versionId);
  };
  return {
    script: edge,
    deploy(input = {}) {
      const deploymentId = createId('dpl');
      const scriptName = functionScriptName(NAMES.project, deploymentId, 'app');
      const deployed = upload(deploymentId, scriptName);
      if (input.functions !== false) {
        fake.scripts.set(scriptName, scriptOf(scriptName, input.createdOn ?? LONG_AGO));
      }
      return deployed;
    },
    redeploy: (deployed) => upload(deployed.deploymentId, deployed.scriptName),
    upload() {
      count += 1;
      edge.versions.unshift({
        id: `version-edge-${String(count)}`,
        number: edge.versions.length + 1,
        metadata: { bindings: [] },
        modules: ['index.mjs'],
        annotations: {},
      });
    },
    serve(shares) {
      count += 1;
      edge.deployments.unshift({
        id: `deployment-edge-${String(count)}`,
        versions: shares.map((share) => {
          return {
            version_id: share.versionId,
            percentage: share.percentage,
          };
        }),
      });
    },
    fetch: (failing = new Set()) => {
      return (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.host === 'api.cloudflare.com') {
          return fake.fetch(input, init);
        }
        const version = routed(request);
        const pointer = pointerOf(version);
        const app = pointer?.['app'] as { readonly deploymentId?: string } | undefined;
        if (url.pathname === '/__upwind/deployment') {
          return Promise.resolve(
            Response.json({
              deploymentId: app?.deploymentId,
              manifestId: pointer?.['manifestId'],
              versionId: version?.id,
              manifest: { kv: true, r2: true },
            }),
          );
        }
        const broken = app?.deploymentId !== undefined && failing.has(app.deploymentId);
        return Promise.resolve(new Response('a page', { status: broken ? 500 : 200 }));
      };
    },
  };
}
