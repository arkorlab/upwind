// A fixture-only host. The binding is a bounded, known-reference handler in the CI process.
const MAX_BYTES = 32 * 1024 * 1024;

export function createCacheHost() { return undefined; }

export function createBundleBlobReader({ env }) {
  if (env?.NO_BLOB_READER === '1') return undefined;
  const binding = env?.BUNDLE_BLOBS;
  if (binding === undefined) return undefined;
  return async (sha256, expectedByteLength) => {
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(expectedByteLength) ||
        expectedByteLength < 1 || expectedByteLength > MAX_BYTES) {
      throw new Error('Invalid fixture blob request');
    }
    const response = await binding.fetch(`https://fixture-blobs.invalid/${sha256}`, {
      headers: { 'x-expected-byte-length': String(expectedByteLength) },
    });
    if (!response.ok || response.body === null) return undefined;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    let complete = false;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) { complete = true; break; }
        size += next.value.byteLength;
        if (size > expectedByteLength) throw new Error('Fixture blob read exceeded its bound');
        chunks.push(next.value);
      }
    } finally {
      if (!complete) await reader.cancel();
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  };
}
