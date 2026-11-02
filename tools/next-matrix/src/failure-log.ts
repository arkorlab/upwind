import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * A failure the Function answers itself, read the way its answer and its log say it: the answer
 * carries a reference and nothing of the failure (`failureBody`, in the runtime's `function.ts`),
 * and the log carries the failure under the same reference. A check that a fixture failed for the
 * reason it was made to fail reads the reason out of the log, then, and not out of the answer.
 */

const FAILURE_BODY =
  /^Internal Server Error \((?<reference>[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\)$/u;
/** workerd hands its log over a moment behind the answer, so a line is waited for this long. */
const LOG_MS = 5000;
const POLL_MS = 25;

/** What a Function's Miniflare logged, line by line, as `handleStructuredLogs` is handed it. */
export function logLines(): {
  readonly lines: string[];
  readonly handleStructuredLogs: (entry: { readonly message: string }) => void;
} {
  const lines: string[] = [];
  return {
    lines,
    handleStructuredLogs: (entry) => {
      lines.push(entry.message);
    },
  };
}

/**
 * That `body` is the Function's own answer to a failure, without `words` in it, and that `lines`
 * came to hold the line the Function logged that failure on, under the answer's reference and with
 * `words` in it.
 */
export async function assertFailureLogged(
  body: string,
  lines: readonly string[],
  words: string,
  said: string,
): Promise<void> {
  const reference = FAILURE_BODY.exec(body)?.groups?.['reference'];
  assert.ok(reference !== undefined, `${said}: not the Function's own answer to a failure`);
  assert.ok(!body.includes(words), `${said}: the answer carries the failure's own words`);
  const logged = `next-runtime: request failed (${reference})`;
  const until = Date.now() + LOG_MS;
  while (lines.every((line) => !line.includes(logged) || !line.includes(words))) {
    assert.ok(Date.now() < until, `${said}: nothing logged ${words} under ${reference}`);
    await delay(POLL_MS);
  }
}
