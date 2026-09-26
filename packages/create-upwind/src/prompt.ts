import { createInterface } from 'node:readline/promises';

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
export async function askDirectory(fallback: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return fallback;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // `using` is not erasable syntax, and the lib this is typed against has no `Symbol.dispose`.
  // eslint-disable-next-line unicorn/prefer-dispose -- see above
  try {
    const answer = await rl.question(`Where should the application go? (${fallback}) `);
    const trimmed = answer.trim();
    return trimmed === '' ? fallback : trimmed;
  } finally {
    rl.close();
  }
}
