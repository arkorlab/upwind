import type { RemoteProxyConnectionString, WorkerOptions } from 'miniflare';

import type { LocalStorageEntry } from './local-bindings.ts';

export const AI_BINDINGS_ENV = 'UPWIND_AI_BINDINGS';
const RAW_AI = 'UPWIND_INTERNAL_AI';
const AI_WORKER = 'upwind-local-ai';
const AI_MODULE = 'upwind-local-ai.mjs';
const CONNECTION_TIMEOUT_MS = 15_000;
const NAME = /^[A-Za-z_$][\w$]{0,63}$/u;

export interface RemoteAiSession {
  readonly remoteProxyConnectionString: RemoteProxyConnectionString;
  readonly ready: Promise<void>;
  readonly dispose: () => Promise<void>;
}

export interface LocalAi {
  readonly entries: readonly LocalStorageEntry[];
  readonly worker?: WorkerOptions;
  readonly dispose: () => Promise<void>;
}

/** Remote setup only receives explicit credentials; it never starts a Wrangler login flow. */
export type RemoteAiFactory = (auth: {
  readonly accountId: string;
  readonly apiToken: string;
}) => Promise<RemoteAiSession>;

async function connect(auth: Parameters<RemoteAiFactory>[0]): Promise<RemoteAiSession> {
  const { startRemoteProxySession } = await import('wrangler');
  // Wrangler's published declaration references an unpublished internal type. Keep the documented
  // session contract explicit until its declarations are independently consumable.
  const start = startRemoteProxySession as (
    bindings: Record<string, { type: 'ai'; remote: true }>,
    options: { auth: () => Promise<Parameters<RemoteAiFactory>[0]> },
  ) => Promise<RemoteAiSession>;
  return start({ [RAW_AI]: { type: 'ai', remote: true } }, { auth: () => Promise.resolve(auth) });
}

/** Declaring AI never connects remotely, and malformed declarations cannot remove storage. */
export function aiBindingNames(raw: string | undefined, occupied: readonly string[]): string[] {
  if (raw === undefined || raw === '') return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== 'string')) {
    throw new TypeError(`${AI_BINDINGS_ENV} must be a JSON array of binding names`);
  }
  const names: string[] = [];
  for (const name of parsed) {
    if (typeof name === 'string') names.push(name);
  }
  const used = new Set(occupied);
  for (const name of names) {
    if (!NAME.test(name) || /^arkor_/iu.test(name) || used.has(name)) {
      throw new TypeError(`${AI_BINDINGS_ENV} contains an invalid or duplicate name: ${name}`);
    }
    used.add(name);
  }
  return names;
}

/** The native Ai object is held only in this worker, never in a customer DO environment. */
export function localInferenceSource(available: boolean, requested = false): string {
  const unavailable = requested
    ? 'Workers AI could not connect locally; check CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and permissions, then restart upwind dev --remote-ai'
    : 'Workers AI is disabled locally; declare UPWIND_AI_BINDINGS and use upwind dev --remote-ai with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN';
  return String.raw`import { WorkerEntrypoint } from 'cloudflare:workers';
const models = new Map();
async function approved(ai, name) {
  let page = 1;
  while (page <= 100) {
    const list = await ai.models({ search: name, page, per_page: 100 });
    if (list.some(model => model.name === name)) return true;
    if (list.length === 0) return false;
    page += 1;
  }
  throw new Error('The public model search exceeded its pagination limit');
}
export default class Inference extends WorkerEntrypoint {
  async run(...args) {
    if (args.length !== 2) throw new TypeError('AI inference accepts only run(model, inputs)');
    if (!${String(available)}) throw new Error(${JSON.stringify(unavailable)});
    const [model, inputs] = args;
    if (typeof model !== 'string' || !/^@(cf|hf)\//.test(model)) throw new TypeError('Only public Workers AI models are supported');
    if (typeof inputs !== 'string' && (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs))) throw new TypeError('AI inputs must be a string, object, binary or stream');
    if (typeof inputs === 'object' && Object.hasOwn(inputs, 'lora')) throw new TypeError('AI inputs cannot include private LoRA adapters');
    if (!models.has(model)) {
      if (models.size >= 256) models.delete(models.keys().next().value);
      const pending = approved(this.env.${RAW_AI}, model).catch(error => {
        if (models.get(model) === pending) models.delete(model);
        throw error;
      });
      models.set(model, pending);
    }
    if (!(await models.get(model))) throw new TypeError('Unknown public Workers AI model');
    return this.env.${RAW_AI}.run(model, inputs);
  }
  fetch() { return new Response('Not found', { status: 404 }); }
}`;
}

function worker(session: RemoteAiSession | undefined, requested: boolean): WorkerOptions {
  return {
    config: {
      name: AI_WORKER,
      compatibilityDate: '2026-09-15',
      manifest: {
        mainModule: AI_MODULE,
        modules: {
          [AI_MODULE]: {
            type: 'esm',
            contents: localInferenceSource(session !== undefined, requested),
          },
        },
      },
      env: session === undefined ? {} : { [RAW_AI]: { type: 'ai', dev: { remote: true } } },
    },
    ...(session !== undefined && {
      dev: { remoteProxyConnectionString: session.remoteProxyConnectionString },
    }),
  };
}

export function localAiBinding(): { type: 'worker'; worker: string } {
  return { type: 'worker', worker: AI_WORKER };
}

async function withinDeadline(starting: Promise<RemoteAiSession>): Promise<RemoteAiSession> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const late = (): boolean => expired;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error('the remote AI connection did not start within 15 seconds'));
    }, CONNECTION_TIMEOUT_MS);
    timer.unref();
  });
  // A late connection must be disposed too, rather than outliving a failed setup attempt.
  const ready = (async () => {
    const session = await starting;
    try {
      if (late()) throw new Error('the remote AI connection arrived after its deadline');
      await Promise.race([session.ready, timeout]);
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  })();
  try {
    return await Promise.race([ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** No model invocation or catalogue probe is part of setup. */
export async function prepareLocalAi(
  occupied: readonly string[],
  remote: boolean,
  factory: RemoteAiFactory = connect,
): Promise<LocalAi> {
  let names: string[];
  try {
    names = aiBindingNames(process.env[AI_BINDINGS_ENV], occupied);
  } catch (error) {
    console.warn(`upwind: could not declare local AI bindings (${String(error)})`);
    names = [];
  }
  const entries = names.map((name): LocalStorageEntry => ({ name, type: 'ai' }));
  let session: RemoteAiSession | undefined;
  if (remote && entries.length > 0) {
    const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
    const apiToken = process.env['CLOUDFLARE_API_TOKEN'];
    if (accountId === undefined || apiToken === undefined || accountId === '' || apiToken === '') {
      console.warn(
        'upwind: remote AI requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN; local storage remains available',
      );
    } else {
      try {
        session = await withinDeadline(factory({ accountId, apiToken }));
      } catch {
        // Provider diagnostics can contain tokens. Keep the diagnostic independent of its error.
        console.warn(
          'upwind: could not connect remote AI; check Cloudflare credentials and permissions; local storage remains available',
        );
      }
    }
  }
  let disposing: Promise<void> | undefined;
  return {
    entries,
    ...(entries.length > 0 && { worker: worker(session, remote) }),
    dispose: async () => {
      disposing ??= session?.dispose() ?? Promise.resolve();
      await disposing;
    },
  };
}
