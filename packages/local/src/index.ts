/**
 * A build served on this machine as it is served deployed (`startStack`), what every deployment's
 * edge has to answer of it (`checkStack`), and the pieces a stack is made of, for a harness that
 * composes one otherwise.
 */
export {
  assertHostOnly,
  type BundledWorker,
  bundleWorker,
  type BundleWorkerOptions,
} from './bundle.ts';
export { type CheckFailure, type CheckOptions, type CheckResult, checkStack } from './check.ts';
export {
  deploymentFunctions,
  type DeploymentFunctions,
  type FunctionBindings,
} from './functions.ts';
export {
  type CspNonceSetting,
  type LocalStack,
  type LocalStorage,
  type StackOptions,
  startStack,
} from './stack.ts';
export { agentTarget } from './target.ts';
