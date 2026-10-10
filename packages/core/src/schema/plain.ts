/** Any object but an array or `null`: what an object schema takes, class instances included. */
export function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An object made as a literal makes one — `{}`, `Object.create(null)` — and not a class instance,
 * an array, a `Date` or a `Map`: what a record schema takes, decided as zod decides it.
 */
export function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (!isObject(value)) {
    return false;
  }
  const constructor: unknown = value.constructor;
  if (constructor === undefined || typeof constructor !== 'function') {
    return true;
  }
  const prototype: unknown = (constructor as { readonly prototype?: unknown }).prototype;
  return isObject(prototype) && Object.hasOwn(prototype, 'isPrototypeOf');
}

/** A default value as each parse receives it: a fresh copy of a plain object, array, `Map` or `Set`. */
export function shallowClone(value: unknown): unknown {
  if (isPlainObject(value)) {
    return { ...value };
  }
  if (Array.isArray(value)) {
    return [...(value as unknown[])];
  }
  if (value instanceof Map) {
    return new Map(value as Map<unknown, unknown>);
  }
  if (value instanceof Set) {
    return new Set(value as Set<unknown>);
  }
  return value;
}
