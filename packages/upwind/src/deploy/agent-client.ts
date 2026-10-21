import { AGENT_PATHS } from './workers/protocol.ts';

/**
 * The deploy agent, as a deploy calls it: over HTTPS, at its `workers.dev` name, with the key the
 * deploy set for this run (`./workers/agent.ts`).
 *
 * Every call to it may be made twice: reads read; a write of a digest-named key finds the same
 * bytes; seeding a scope already seeded says so; a scope retired twice was retired once. So a call
 * that does not reach the agent, or that it answers with a 5xx or 429, is made again, a few times.
 * A 401 is not: it means another run has set a key of its own since this one began, and the right
 * thing for this run to do is stop.
 */

const MAX_ATTEMPTS = 4;
const FIRST_WAIT_MS = 500;
const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR = 500;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;

export interface AgentClient {
  readonly url: URL;
  /** The answer to a request, made again while it may be; nothing for a 404. */
  call(
    method: string,
    path: string,
    init?: { readonly body?: BodyInit; readonly headers?: Readonly<Record<string, string>> },
  ): Promise<Response | undefined>;
}

export interface AgentClientOptions {
  readonly url: URL;
  readonly key: string;
  readonly fetch?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** What the agent said, for a message. */
async function refusedBy(response: Response, what: string): Promise<Error> {
  if (response.status === UNAUTHORIZED) {
    await response.body?.cancel();
    return new Error(
      `the deploy agent no longer takes this run's key for ${what}: another deploy of the project has started since this one did`,
    );
  }
  return new Error(
    `the deploy agent answered ${response.status} to ${what}: ${await response.text()}`,
  );
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The answer a call ends with — a response, or nothing for a 404 — where it is not made again. */
async function settled(response: Response, what: string): Promise<Response | undefined> {
  if (response.status === NOT_FOUND) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    throw await refusedBy(response, what);
  }
  return response;
}

function askedAgain(response: Response | undefined): boolean {
  return (
    response === undefined ||
    response.status === TOO_MANY_REQUESTS ||
    response.status >= SERVER_ERROR
  );
}

export function agentClient(options: AgentClientOptions): AgentClient {
  const send = options.fetch ?? fetch;
  const sleep = options.sleep ?? waitFor;
  /** One attempt: what the agent answered, or nothing where it could not be reached. */
  const attempt = async (
    method: string,
    path: string,
    init: Parameters<AgentClient['call']>[2] = {},
  ): Promise<{ readonly response: Response | undefined; readonly error: unknown }> => {
    try {
      const response = await send(new URL(path, options.url), {
        method,
        headers: { ...init.headers, authorization: `Bearer ${options.key}` },
        body: init.body ?? null,
      });
      return { response, error: undefined };
    } catch (error) {
      return { response: undefined, error };
    }
  };
  return {
    url: options.url,
    async call(method, path, init = {}) {
      const what = `${method} ${path}`;
      for (let count = 1; ; count += 1) {
        const { response, error } = await attempt(method, path, init);
        const last = count >= MAX_ATTEMPTS;
        if (last && response === undefined) {
          throw new Error(`the deploy agent could not be reached for ${what}`, { cause: error });
        }
        if (response !== undefined && (last || !askedAgain(response))) {
          return settled(response, what);
        }
        await response?.body?.cancel();
        await sleep(FIRST_WAIT_MS * 2 ** (count - 1));
      }
    },
  };
}

/** Whether the agent takes the key: what a deploy waits for after setting one. */
export async function agentTakesKey(agent: AgentClient): Promise<boolean> {
  try {
    return (await agent.call('GET', AGENT_PATHS.health)) !== undefined;
  } catch {
    return false;
  }
}
