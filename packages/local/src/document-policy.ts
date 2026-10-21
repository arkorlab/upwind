import { type CheckedStack, FROM_STORAGE, policyFailure, SHELL_ANSWER } from './answers.ts';
import type { Reading } from './reading.ts';

/** Only edge-held documents and foreground regenerations carry the deployment policy. */
export function heldPolicyFailure(
  stack: CheckedStack,
  answer: Reading,
  answered: string,
): string | undefined {
  const held =
    /^passthrough;reason=regenerate(?:;|$)/u.test(answered) ||
    answered.startsWith(SHELL_ANSWER) ||
    answered.startsWith(FROM_STORAGE);
  return held ? policyFailure(stack, answer) : undefined;
}
