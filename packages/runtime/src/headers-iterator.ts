/**
 * Web IDL gives a pair iterable the same native function for `entries` and `Symbol.iterator`.
 * workerd registers them separately. Reuse its named method before application evaluation so
 * Headers, including those native Request and Response objects already own, share that alias.
 */
export function installHeadersIterator(): void {
  const prototype = Headers.prototype;
  const entries = Object.getOwnPropertyDescriptor(prototype, 'entries');
  const iterator = Object.getOwnPropertyDescriptor(prototype, Symbol.iterator);
  if (
    entries === undefined ||
    iterator === undefined ||
    !('value' in entries) ||
    !('value' in iterator) ||
    iterator.writable !== true ||
    typeof entries.value !== 'function' ||
    iterator.value === entries.value
  ) {
    return;
  }
  // Preserve the native descriptor and leave an immutable implementation alone.
  Reflect.defineProperty(prototype, Symbol.iterator, { ...iterator, value: entries.value });
}
