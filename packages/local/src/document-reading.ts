import { RECOVERY_MARKER } from '@stayingupwind/core/request';

import {
  answerTo,
  type CheckedStack,
  type Kept,
  keptOf,
  traced,
  undoneUnlessStored,
} from './answers.ts';
import type { Accepted } from './codings.ts';
import { restampAt } from './nonces.ts';
import type { ReadOptions, Reading } from './reading.ts';

const RECOVERY = Buffer.from(RECOVERY_MARKER);

/** A document request whose body is read as the browser reads it, without retaining it whole. */
interface DocumentAsk {
  readonly requested: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly coding?: Accepted | undefined;
  readonly headersOnly?: ReadOptions['headersOnly'];
}

/** The existing document reading, including streaming nonce proof and coded-file handling. */
export function readDocument(
  stack: CheckedStack,
  headBytes: number,
  asked: DocumentAsk,
  headers: Readonly<Record<string, string>>,
): Promise<Reading | string> {
  const url = new URL(asked.requested, stack.site);
  return answerTo(url, {
    via: stack.url,
    headers,
    headBytes,
    marker: RECOVERY,
    copyTo: (sent) => restampAt(stack, sent, asked.coding !== undefined),
    decode: undoneUnlessStored(asked.coding !== undefined),
    headersOnly: asked.headersOnly,
  });
}

/** Headers discarded on the way, or the adopted response with its request's captured evidence. */
type CapturedDocument =
  | { readonly kind: 'headers'; readonly answer: Reading }
  | { readonly kind: 'document'; readonly answer: Reading; readonly kept: Kept };

/** A redirect's own bounded body summary and backstage snapshot, retained before trace disposal. */
export async function capturedDocument(
  stack: CheckedStack,
  headBytes: number,
  asked: DocumentAsk,
): Promise<string | CapturedDocument> {
  await using tracing = await traced(stack, asked.headers);
  const answer = await readDocument(stack, headBytes, asked, tracing.headers);
  if (typeof answer === 'string') {
    return answer;
  }
  if (answer.truncated) {
    return { kind: 'headers', answer };
  }
  const url = new URL(asked.requested, stack.site);
  const kept = await keptOf(stack, tracing.trace, url, asked.headers);
  return { kind: 'document', answer, kept };
}
