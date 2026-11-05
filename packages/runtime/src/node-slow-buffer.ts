import { Buffer } from 'node:buffer';

/** Next 16.4.3's fixed JWT dependency reads SlowBuffer.prototype at initialization. */
function SlowBuffer(size: number): Buffer {
  return Buffer.allocUnsafeSlow(size);
}
// Match the constructors/prototype chains of Node 24's lib/buffer.js. Allocation and argument
// validation use the same allocUnsafeSlow implementation; no pooled memory is substituted.
Object.setPrototypeOf(SlowBuffer, Uint8Array);
Object.setPrototypeOf(SlowBuffer.prototype, Uint8Array.prototype);

const installed: { buffer: Record<string, unknown> | undefined } = { buffer: undefined };

/** Trusted pre-app setup only. Never replace a supplied export or accept a changed installation. */
export function initializeNodeSlowBuffer(buffer: Record<string, unknown>): void {
  if (process.versions.node !== '26.13.0') return;
  const descriptor = Object.getOwnPropertyDescriptor(buffer, 'SlowBuffer');
  if (installed.buffer === buffer) {
    if (
      descriptor?.value !== SlowBuffer ||
      descriptor.writable !== true ||
      descriptor.enumerable !== true ||
      descriptor.configurable !== true
    )
      throw new Error('Unsupported Node JWT initialization: changed SlowBuffer compatibility');
    return;
  }
  if (descriptor !== undefined)
    throw new Error('Unsupported Node JWT initialization: unexpected SlowBuffer export');
  Object.defineProperty(buffer, 'SlowBuffer', {
    value: SlowBuffer,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  installed.buffer = buffer;
}
