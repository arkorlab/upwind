import {
  type DeploymentBundle,
  type FunctionSpec,
  isNodeContainerFunction,
  type WorkerFunctionSpec,
} from '@stayingupwind/core/bundle';

/** These controls exercise workerd; a Node artifact needs the separate Linux Container control. */
export function workerSpec(spec: FunctionSpec): WorkerFunctionSpec {
  if (isNodeContainerFunction(spec))
    throw new Error('This Worker-only control cannot execute a native Function Container artifact');
  return spec;
}

export function workerApp(bundle: Pick<DeploymentBundle, 'functions'>): WorkerFunctionSpec {
  return workerSpec(bundle.functions.app);
}
