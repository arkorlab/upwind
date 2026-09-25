import { MAX_PACK_BYTES } from '@upwind/core/cache';
import { RESUME_STATE_LENGTH_HEADER } from '@upwind/core/paas';

// State arrives via metadata, not Next.js's internally limited postponed request body.
// Every state that fits the generation record must also be resumable.
const MAX_RESUME_STATE_BYTES = MAX_PACK_BYTES;

export async function readResumeState(request: Request): Promise<string | undefined> {
  const length = request.headers.get(RESUME_STATE_LENGTH_HEADER);
  const declared = Number(length);
  if (
    length === null ||
    !Number.isSafeInteger(declared) ||
    declared <= 0 ||
    declared > MAX_RESUME_STATE_BYTES ||
    request.body === null
  ) {
    return undefined;
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const text: string[] = [];
  let received = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      received += next.value.byteLength;
      if (received > declared) {
        await reader.cancel();
        return undefined;
      }
      text.push(decoder.decode(next.value, { stream: true }));
    }
    text.push(decoder.decode());
    return received === declared ? text.join('') : undefined;
  } finally {
    reader.releaseLock();
  }
}
