import { pathToFileURL } from 'node:url';

import { resolveFromProject } from './next-app.ts';

/**
 * Keep `AGENTS.md` and `CLAUDE.md` current, the way `next dev` does.
 *
 * Next.js writes those two files when it finds an AI coding agent running a dev server against a
 * project whose agent-rules block is missing or stale — the block says that this major is not the
 * Next.js the agent was trained on, which is the kind of wrong that compiles. It does that in
 * `startServer`, which a custom server does not go through: without this, a project run by
 * `upwind dev` is one where nobody ever writes them. The same absence, for the same reason, as
 * `config-watch.ts`.
 *
 * None of the work is done here. Every piece is Next.js's own, resolved from the *project's* copy at
 * runtime, so a project gets what its own Next.js would have written — including the decision about
 * what counts as current. Nothing is imported statically: this package depends on `next` for its
 * types, and the copy that matters is never that one.
 *
 * Never fatal, and never loud about what it could not find. A Next.js without these modules is one
 * that did not have the feature or has moved it, and a dev server that runs is worth more than one
 * that refused over two markdown files.
 */

/**
 * What Next.js reports having done to each file.
 *
 * Every field optional, because this is a foreign function's return value and the only thing read
 * off it is a line to print. A release that reports something else leaves the files written and the
 * line unsaid, rather than throwing away the work on the way to describing it.
 */
type AgentFileResult = 'created' | 'skipped' | 'unchanged' | 'updated';
interface WriteResult {
  readonly agentsMd?: AgentFileResult;
  readonly claudeMd?: AgentFileResult;
}

/** What a function of somebody else's may start returning without telling anyone. */
type Awaitable<T> = PromiseLike<T> | T;

/**
 * Both places an export of a CommonJS module of the project's can arrive, for one name.
 *
 * The reason `config-watch.ts` gives: Node's lexer reads the names out of some CommonJS modules and
 * not others, and one whose shape it cannot read arrives with the whole of `module.exports` under
 * `default` instead. Next.js's `dist` defines its exports through getters, which is exactly the
 * shape the lexer is unsure about, so neither way is bet on.
 *
 * Both are returned rather than the first that is there, because `default` is a name a module can
 * have of its own: `next/dist/server/config.js` exports `loadConfig` as its default, and a namespace
 * whose `default` is the `module.exports` object has a `default` that is present, not callable, and
 * hiding the function one level down. What each is worth is the caller's question, below.
 */
async function fromProject(
  projectDir: string,
  specifier: string,
  name: string,
): Promise<readonly unknown[]> {
  const entry = resolveFromProject(projectDir, specifier);
  if (entry === undefined) {
    return [];
  }
  try {
    const module = (await import(pathToFileURL(entry).href)) as Record<string, unknown> & {
      default?: Record<string, unknown>;
    };
    return [module[name], module.default?.[name]];
  } catch {
    return [];
  }
}

/** The first of them that can be called, since one that cannot is not the export being looked for. */
async function functionFromProject<T extends (...args: never[]) => unknown>(
  projectDir: string,
  specifier: string,
  name: string,
): Promise<T | undefined> {
  const found = await fromProject(projectDir, specifier, name);
  return found.find((value) => typeof value === 'function') as T | undefined;
}

/** The same, for a constant. */
async function stringFromProject(
  projectDir: string,
  specifier: string,
  name: string,
): Promise<string | undefined> {
  const found = await fromProject(projectDir, specifier, name);
  return found.find((value) => typeof value === 'string');
}

/** Where Next.js keeps the two of these, named once because two things are read out of it. */
const GENERATE_AGENT_FILES = 'next/dist/server/lib/generate-agent-files.js';

/**
 * Does this project's `next.config` turn the whole thing off?
 *
 * `agentRules: false` is Next.js's own switch, and a project that set it meant it for `upwind dev`
 * too. Reading it costs a second config load — `next dev` reads the one it already has, a custom
 * server has no way to reach that one, and `next dev` loads it exactly once, so this really is an
 * evaluation of the project's config that would not otherwise have happened. Which is why it is
 * asked last, when there is something to write and nothing else left to decide: a run with no agent,
 * or with the block already current, never gets here at all.
 *
 * A second evaluation is a second answer, and it can differ from the first for any reason the
 * config's own value depends on: the clock, a file written between the two, state the first
 * evaluation left behind. That is what evaluating it twice means, and it is why it is only ever
 * evaluated twice on the run that is about to write.
 *
 * The difference upwind itself puts there is one: this is asked *after* `serve.ts` has restored the
 * environment (`adapter.restore()`, `restoreAddress()`), so `NEXT_ADAPTER_PATH` and
 * `UPWIND_DEV_ADDRESS` are set while Next.js reads the config and unset while this does. A config
 * deriving `agentRules` from those is a project saying "not under upwind", and the way to say that
 * and be obeyed is `agentRules: false` outright — the same switch, read the same by both, and
 * honoured by `next dev` too. Reading it before the restore instead would hold every queued request
 * through a config load, on the one run that needs one.
 */
async function agentRulesAllowed(projectDir: string): Promise<boolean> {
  type LoadConfig = (
    phase: string,
    dir: string,
    options: { silent: boolean },
  ) => Promise<{ agentRules?: unknown }>;
  const loadConfig = await functionFromProject<LoadConfig>(
    projectDir,
    'next/dist/server/config.js',
    'default',
  );
  const phase = await stringFromProject(
    projectDir,
    'next/constants.js',
    'PHASE_DEVELOPMENT_SERVER',
  );
  if (loadConfig === undefined || phase === undefined) {
    // Nothing to read the switch out of. Writing is what Next.js does unless told otherwise, so it
    // is what happens when there is no way to ask whether it was.
    return true;
  }
  try {
    // The config file is evaluated a second time by this, after `prepare()` evaluated it once. It is
    // the same file Next.js just loaded successfully, so what comes back is what Next.js is running.
    const config = await loadConfig(phase, projectDir, { silent: true });
    return config.agentRules !== false;
  } catch {
    // And if this load is the one that fails, it is still the same "no way to ask" as above, and it
    // gets the same answer — rather than the silence that swallowing the whole thing would give.
    return true;
  }
}

/** The files that were actually written, for the one line this prints. */
function written(result: WriteResult | undefined): readonly string[] {
  const names: string[] = [];
  if (result?.agentsMd === 'created' || result?.agentsMd === 'updated') {
    names.push('AGENTS.md');
  }
  if (result?.claudeMd === 'created' || result?.claudeMd === 'updated') {
    names.push('CLAUDE.md');
  }
  return names;
}

export async function ensureAgentRules(projectDir: string): Promise<void> {
  try {
    // Cheapest first, in the order that ends the ordinary runs soonest. Agent detection is a handful
    // of environment variables and one `access`, and a developer at a keyboard stops there.
    const getAgentName = await functionFromProject<() => Promise<string | null>>(
      projectDir,
      'next/dist/telemetry/agent-name.js',
      'getAgentName',
    );
    if (getAgentName === undefined || (await getAgentName()) === null) {
      return;
    }
    // Both awaited, though Next.js does the two of them synchronously today. A version that turned
    // either into a promise would otherwise be read as its promise: a truthy one from the first,
    // which is every project answered "already current" and never written to, and an object with no
    // `agentsMd` from the second, which is the files written and the line never said.
    const hasCurrentAgentRules = await functionFromProject<(dir: string) => Awaitable<boolean>>(
      projectDir,
      GENERATE_AGENT_FILES,
      'hasCurrentAgentRules',
    );
    const writeAgentFiles = await functionFromProject<
      (dir: string) => Awaitable<WriteResult | undefined>
    >(projectDir, GENERATE_AGENT_FILES, 'writeAgentFiles');
    if (hasCurrentAgentRules === undefined || writeAgentFiles === undefined) {
      return;
    }
    // Two file reads, and the answer for every run after the one that wrote them.
    if (await hasCurrentAgentRules(projectDir)) {
      return;
    }
    if (!(await agentRulesAllowed(projectDir))) {
      return;
    }
    const names = written(await writeAgentFiles(projectDir));
    if (names.length > 0) {
      console.log(
        `  ✓ ${names.join(' and ')} written for the coding agent running this (\`agentRules: false\` in next.config turns it off)`,
      );
    }
  } catch {
    // A config that will not load, a Next.js that has moved these, a checkout nothing may write to:
    // none of them is a reason to have failed to start a dev server.
  }
}
