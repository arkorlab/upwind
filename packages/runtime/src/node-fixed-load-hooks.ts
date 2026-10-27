import { Module } from 'node:module';

import {
  assertNodeFixedLoadScope,
  poisonNodeFixedLoadScope,
  type NodeFixedLoadScope,
} from './node-fixed-load-scope.ts';

const descriptorOf = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const hasOwn = Object.hasOwn;
const apply = Reflect.apply;
const NativeError = Error;

interface Load {
  readonly filename: string;
  readonly request: unknown;
  readonly parent: unknown;
}
interface Callbacks {
  before(load: Load): void;
  after(load: Load, result: unknown): void;
  failure(load: Load, error: unknown): boolean;
}

/** Preserve both the actual loader and the outer require tracing boundary, once per call. */
export function installNodeFixedLoadHooks(
  scope: NodeFixedLoadScope,
  callbacks: Callbacks,
): () => void {
  const loadDescriptor = descriptorOf(Module, '_load');
  const requireDescriptor = descriptorOf(Module.prototype, 'require');
  const originalLoad: unknown = loadDescriptor?.value;
  const originalRequire: unknown = requireDescriptor?.value;
  if (
    typeof originalLoad !== 'function' ||
    typeof originalRequire !== 'function' ||
    loadDescriptor === undefined ||
    requireDescriptor === undefined ||
    !hasOwn(loadDescriptor, 'value') ||
    !hasOwn(requireDescriptor, 'value')
  )
    throw new NativeError('Unsupported fixed Node loader methods');
  const loadMethod = originalLoad;
  const requireMethod = originalRequire;
  function observe(request: unknown, parent: unknown, run: () => unknown): unknown {
    const match = assertNodeFixedLoadScope(scope, request, parent);
    if (match === undefined) return run();
    const info = { filename: match.filename, request, parent };
    try {
      callbacks.before(info);
    } catch (error) {
      poisonNodeFixedLoadScope(scope, match.filename, error);
      throw error;
    }
    let result: unknown;
    try {
      result = run();
    } catch (error) {
      try {
        if (!callbacks.failure(info, error)) poisonNodeFixedLoadScope(scope, match.filename, error);
      } catch (error_) {
        poisonNodeFixedLoadScope(scope, match.filename, error_);
        throw error_;
      }
      throw error;
    }
    try {
      callbacks.after(info, result);
    } catch (error) {
      poisonNodeFixedLoadScope(scope, match.filename, error);
      throw error;
    }
    return result;
  }
  function load(this: unknown, ...args: unknown[]): unknown {
    return observe(args[0], args[1], () => apply(loadMethod, this, args));
  }
  function require(this: unknown, ...args: unknown[]): unknown {
    return observe(args[0], this, () => apply(requireMethod, this, args));
  }
  defineProperty(Module, '_load', { ...loadDescriptor, value: load });
  try {
    defineProperty(Module.prototype, 'require', { ...requireDescriptor, value: require });
  } catch (error) {
    defineProperty(Module, '_load', loadDescriptor);
    throw error;
  }
  return () => {
    defineProperty(Module.prototype, 'require', requireDescriptor);
    defineProperty(Module, '_load', loadDescriptor);
  };
}
