/**
 * The edge on its own: one site, its pointer pinned on the Worker or kept in `EDGE_STATE`, its
 * Functions and its routes' gates reached over service bindings. What a host with no deployment
 * service of its own deploys (`./standalone/worker`), and what it is made of, for a host that
 * composes it otherwise.
 */
export { functionBinding, gateBinding } from '@stayingupwind/host/bindings';

export type { StandaloneEnv } from './env.ts';
export { handleStandalone } from './handle.ts';
export { GateNotBoundError, STANDALONE_NAMES, standaloneHost } from './host.ts';
export { FunctionNotBoundError, standaloneRuntime } from './runtime.ts';
