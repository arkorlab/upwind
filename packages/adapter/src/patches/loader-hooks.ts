import { RAW_BODY_MODULE, RAW_BODY_SOURCE } from './raw-body.ts';

/**
 * Modules a Function has no use for, or cannot load, resolved to a module of the adapter's rather
 * than bundled.
 *
 * `require-in-the-middle` and `import-in-the-middle` hook Node's module loader; Sentry's
 * OpenTelemetry instrumentation registers them. A Function has no module loader to hook, so they
 * resolve to a module that hooks nothing. Turbopack may suffix an externalised package with a
 * hash.
 *
 * A module that hooks nothing, and not an empty one: `new Hook(...)` is how a hook is registered,
 * which an empty module makes a `TypeError`. It is thrown where Next.js loads the instrumentation
 * hook, so every request the deployment serves is a 500 — as one configured with a Sentry DSN
 * was, since that is what makes its Node SDK install the instrumentation.
 *
 * `critters` is required by the Pages Router runtime for `experimental.optimizeCss`, which
 * inlines critical CSS from the built stylesheets on disk: an app that turns it on is refused at
 * the first render rather than at the bundle, in so many words.
 *
 * `next/dist/compiled/raw-body` cannot be loaded by workerd (see `raw-body.ts`); the Pages
 * Router's API body parser gets a copy that reads the stream the same way.
 *
 * `node:process` is not found by workerd's `require`, although its `import` finds it: under the
 * Function's compatibility date and flags a CommonJS module asking for it is told there is no such
 * module. The global is that very module (`import process from 'node:process'` is
 * `globalThis.process`), and the bundle, CommonJS, is handed the global. OpenTelemetry's Node.js
 * SDK requires it, and an application whose instrumentation started one answered every render
 * with a 500 (`cache-components-allow-otel-spans`).
 */

const LOADER_HOOKS = /^(?:require-in-the-middle|import-in-the-middle)(?:-[0-9a-f]+)?$/u;
const OPTIONAL_MODULES = /^critters$/u;
const PROCESS_MODULE = /^(?:node:)?process$/u;
const PROCESS_SOURCE = 'module.exports = globalThis.process;';

/**
 * What both packages export: the `Hook` constructor itself, named as well, with the rest of
 * `import-in-the-middle`'s surface beside it. A hook that registers nothing has nothing to
 * unregister, and the channel a loader would answer on carries no messages to wait for.
 */
const STUB_SOURCE = `function Hook() {}
Hook.prototype.unhook = function () {};
function addHook() {}
function removeHook() {}
function createAddHookMessageChannel() {
  return {
    registerOptions: { data: { include: [] }, transferList: [] },
    addHookMessagePort: undefined,
    waitForAllMessagesAcknowledged: function () { return Promise.resolve(); },
  };
}
module.exports = Hook;
module.exports.Hook = Hook;
module.exports.addHook = addHook;
module.exports.removeHook = removeHook;
module.exports.createAddHookMessageChannel = createAddHookMessageChannel;
`;
const UNSUPPORTED_SOURCE =
  'module.exports = class Critters { constructor() { throw new Error("experimental.optimizeCss is not supported on this platform"); } };';

/**
 * `node:vm`, for the workflow Function (`workflow.ts`) and nothing else.
 *
 * The SDK imports it for the engine it replays a workflow on by default, and runs every workflow on
 * its QuickJS engine here instead (`WORKFLOW_VM=quickjs`, which the runtime sets): what it imported
 * is never called. workerd's own module would answer a call with `ERR_METHOD_NOT_IMPLEMENTED`; this
 * one says why. Anything else that imports `node:vm` still fails the build, which is the audit's
 * point (`FORBIDDEN_IN_APP`): the stub is given only to what the workflow Function's server chunks
 * import, never to the application's or the middleware's Function. It has no `runInNewContext`,
 * the one name the audit refuses wherever it appears, since the SDK calls none and the audit would
 * refuse the stub itself.
 */
export const NODE_VM_MODULE = /^(?:node:)?vm$/u;
export const NODE_VM_SOURCE = `function unavailable(name) {
  return function () {
    throw new Error("node:vm." + name + " cannot run on workerd, which evaluates no code at run time; the Workflow SDK's workflows run on its QuickJS engine (WORKFLOW_VM=quickjs)");
  };
}
class Script {
  constructor() {
    unavailable("Script")();
  }
}
module.exports = {
  Script,
  compileFunction: unavailable("compileFunction"),
  createContext: unavailable("createContext"),
  isContext: function () { return false; },
  measureMemory: unavailable("measureMemory"),
  runInContext: unavailable("runInContext"),
  runInThisContext: unavailable("runInThisContext"),
  constants: {},
};
`;

export function isStubbedModule(specifier: string): boolean {
  return (
    LOADER_HOOKS.test(specifier) ||
    OPTIONAL_MODULES.test(specifier) ||
    RAW_BODY_MODULE.test(specifier) ||
    PROCESS_MODULE.test(specifier)
  );
}

/** What stands in for a module: nothing, a refusal, the adapter's own copy, or the global. */
export function stubSourceFor(specifier: string): string {
  if (RAW_BODY_MODULE.test(specifier)) {
    return RAW_BODY_SOURCE;
  }
  // Resolved here for the workflow Function alone (`stubPlugin`), which is why `isStubbedModule`
  // says no to it.
  if (NODE_VM_MODULE.test(specifier)) {
    return NODE_VM_SOURCE;
  }
  if (PROCESS_MODULE.test(specifier)) {
    return PROCESS_SOURCE;
  }
  return OPTIONAL_MODULES.test(specifier) ? UNSUPPORTED_SOURCE : STUB_SOURCE;
}
