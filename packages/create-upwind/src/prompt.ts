import { once } from 'node:events';
import { createInterface, type Interface } from 'node:readline/promises';

/**
 * The one question this asks.
 *
 * One, because there is one template: everything else a scaffolder usually asks — TypeScript, the
 * router, the bundler — is already decided by what upwind runs. A question with one possible answer
 * is a keystroke taken from someone who typed `pnpm create upwind` to get an application.
 *
 * Asked only of a terminal. `pnpm create upwind < /dev/null`, or the same from a script or a CI job,
 * takes the default rather than waiting for an answer that is never coming — a scaffolder that hangs
 * on a closed stdin is one that hangs a pipeline.
 */

/** The default is what an empty answer means, and Ctrl-D is the emptiest answer there is. */
const NO_ANSWER = '';

/** The answer an input that closed without one gives. */
async function untilClosed(rl: Interface): Promise<string> {
  await once(rl, 'close');
  return NO_ANSWER;
}

/**
 * The answer, or none.
 *
 * Ctrl-D does not answer the question, it abandons it: Node rejects the promise with an
 * `AbortError` — "Aborted with Ctrl+D" — rather than resolving it with nothing. Caught here, because
 * an input that has ended has no more answers to give, and the one this asks for has a default.
 */
async function askOnce(rl: Interface, prompt: string): Promise<string> {
  try {
    return await rl.question(prompt);
  } catch {
    return NO_ANSWER;
  }
}

export async function askDirectory(fallback: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return fallback;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // `using` is not erasable syntax, and the lib this is typed against has no `Symbol.dispose`.
  // eslint-disable-next-line unicorn/prefer-dispose -- see above
  try {
    // An input that ends means the default, whichever way it ends: `askOnce` catches the rejection
    // Ctrl-D raises, and the race catches a close that leaves the question unanswered and
    // unrejected. Either way this returns, because a scaffolder that ends having written nothing is
    // not an answer to `pnpm create upwind`.
    const answer = await Promise.race([
      askOnce(rl, `Where should the application go? (${fallback}) `),
      untilClosed(rl),
    ]);
    const trimmed = answer.trim();
    return trimmed === NO_ANSWER ? fallback : trimmed;
  } finally {
    rl.close();
  }
}
