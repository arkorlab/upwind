/**
 * What a Function needs from the runtime when its deployment carries the Workflow SDK (`workflow`,
 * Vercel's `"use workflow"`): two things, both about the engine a workflow is replayed on.
 *
 * - **Which engine.** The SDK replays a workflow on `node:vm` unless `WORKFLOW_VM` says otherwise,
 *   and workerd's `node:vm` refuses every call: evaluating code at run time is what workerd does
 *   not do. The SDK's QuickJS engine — a JavaScript interpreter compiled to WebAssembly — is what
 *   runs there, so it is the default in every Function of such a deployment. Every one, and not
 *   only the workflow Function: `start()` stamps the run with the engine of the Function that
 *   started it, and that stamp decides how the run is replayed for good. A value the host set is
 *   left as it is.
 * - **Its WebAssembly, already compiled.** The engine carries its modules as base64 and compiles
 *   them with `WebAssembly.compile`, which workerd refuses as well. The adapter ships each of them
 *   as a module of the Function's own instead, compiled when the Function was uploaded, and hands
 *   the engine that module where it decoded bytes (`workflow-quickjs-wasm` in the adapter). So
 *   `WebAssembly.compile`, given a module that is already compiled, answers with it, in the one
 *   Function that runs the engine; given anything else it does what it did, which here is refuse.
 */

const DEFAULT_ENGINE = 'quickjs';

type Compile = typeof WebAssembly.compile;

function answerCompiledModules(): void {
  const compile: Compile = WebAssembly.compile.bind(WebAssembly);
  const passThrough = async (
    source: Parameters<Compile>[0],
    ...rest: Parameters<Compile> extends [unknown, ...infer Rest] ? Rest : never
  ): Promise<WebAssembly.Module> => {
    if (source instanceof WebAssembly.Module) {
      return source;
    }
    return compile(source, ...rest);
  };
  WebAssembly.compile = passThrough;
}

export function installWorkflowSdk(): void {
  process.env['WORKFLOW_VM'] ??= DEFAULT_ENGINE;
  if (__ARKOR_FUNCTION_KIND__ === 'workflow') {
    answerCompiledModules();
  }
}
