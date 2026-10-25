/** Native transport primitives; importing these opens no socket and changes no global. */
export {
  createNodeBridge,
  NodeBridgeError,
  type NodeBridge,
  type NodeBridgeErrorCode,
  type NodeBridgeOptions,
} from './bridge.ts';
export { TaskGroup } from './lifetime.ts';
export type { FailureAnswer, InvokeInput, Run } from '../invocation.ts';
