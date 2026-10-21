import { randomBytes } from 'node:crypto';

import { type AgentClient, agentClient, agentTakesKey } from './agent-client.ts';
import type { WorkerBinding } from './cloudflare/form.ts';
import {
  type AccountScope,
  putScript,
  putSecret,
  type ScriptSubdomain,
} from './cloudflare/workers.ts';
import type { ProjectNames } from './names.ts';
import type { WorkerScript } from './shipped.ts';
import type { ProjectStores } from './stores.ts';
import { COMPATIBILITY_DATE, ensureWorker, holdReach, shippedForm } from './uploads.ts';
import { type DESTROY_MODE } from './workers/protocol.ts';

/**
 * The deploy agent, for one run: uploaded with a key of the run's own, waited on until it takes
 * that key on `workers.dev`, and given a key nobody holds when the run is over.
 *
 * Uploaded every run, the key with it, rather than given a new key alone: one upload is the code
 * and the key at once, so a run never reaches an agent of another version with its key. The key is
 * the run's lock as well — a second run uploads its own, and the first one's calls are refused from
 * then on (`agent-client.ts`).
 */

/** The agent is reached on `workers.dev`, and on no version's preview URL. */
const AGENT_REACH: ScriptSubdomain = { enabled: true, previews_enabled: false };
const KEY_BYTES = 32;
/** How long a new agent, or a new key, may take to be answered on `workers.dev`. */
const AGENT_WAIT_MS = 120_000;
const POLL_MS = 2000;
const SECOND_MS = 1000;

export type AgentMode = 'deploy' | typeof DESTROY_MODE;

export interface AgentSession {
  readonly client: AgentClient;
  /** Give the agent a key nobody holds. */
  close(): Promise<void>;
}

export interface AgentInput {
  readonly scope: AccountScope;
  readonly names: ProjectNames;
  /** The bucket, and the edge's namespace — which a project being destroyed may not have. */
  readonly stores: Pick<ProjectStores, 'bucket'> & { readonly edgeState: string | undefined };
  readonly script: WorkerScript;
  readonly subdomain: string;
  readonly mode: AgentMode;
  readonly existing: ReadonlySet<string>;
  /** Whether the cache is there to bind; a project being destroyed may have lost it already. */
  readonly withCache: boolean;
  readonly fetch?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

function freshKey(): string {
  return randomBytes(KEY_BYTES).toString('base64url');
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function bindingsOf(input: AgentInput, key: string): WorkerBinding[] {
  const { edgeState } = input.stores;
  return [
    ...(edgeState === undefined
      ? []
      : [{ type: 'kv_namespace', name: 'EDGE_STATE', namespace_id: edgeState } as const]),
    { type: 'r2_bucket', name: 'ARTIFACTS', bucket_name: input.stores.bucket },
    ...(input.withCache
      ? [
          {
            type: 'service',
            name: 'CACHE_CONTROL',
            service: input.names.cache,
            entrypoint: 'CacheControl',
          } as const,
        ]
      : []),
    { type: 'plain_text', name: 'AGENT_MODE', text: input.mode },
    { type: 'secret_text', name: 'AGENT_KEY', text: key },
  ];
}

/** Upload the agent with a key of this run's, and wait until it is answered with that key. */
export async function openAgent(input: AgentInput): Promise<AgentSession> {
  const { scope, names } = input;
  const key = freshKey();
  await ensureWorker(scope, names.agent, AGENT_REACH, input.existing);
  await putScript(
    scope,
    names.agent,
    shippedForm(input.script.script, {
      compatibility_date: COMPATIBILITY_DATE,
      bindings: bindingsOf(input, key),
      annotations: { 'workers/message': `upwind deploy (${input.mode})` },
    }),
  );
  await holdReach(scope, names.agent, AGENT_REACH);
  const sleep = input.sleep ?? waitFor;
  const client = agentClient({
    url: new URL(`https://${names.agent}.${input.subdomain}.workers.dev/`),
    key,
    fetch: input.fetch,
    sleep,
  });
  const close = async (): Promise<void> => {
    await putSecret(scope, names.agent, { name: 'AGENT_KEY', text: freshKey() });
  };
  const now = input.now ?? Date.now;
  const until = now() + AGENT_WAIT_MS;
  // A new Worker takes a moment to be routed on `workers.dev`, and a new key to reach every place
  // the old one is cached.
  while (!(await agentTakesKey(client))) {
    if (now() >= until) {
      await close();
      throw new Error(
        `${names.agent} did not answer with this run's key on workers.dev within ${String(AGENT_WAIT_MS / SECOND_MS)} s`,
      );
    }
    await sleep(POLL_MS);
  }
  return { client, close };
}
