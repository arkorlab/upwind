/**
 * The record of one way a value failed, built the way zod 4 builds its own, so that a parse reads
 * the same whichever of the two ran it: the same keys, in the same order, with the same message.
 * Code that reads `issues` — or `error.message`, which is their JSON — sees no difference.
 */

/** An issue as a schema raises it, before it is reported. */
export interface RawIssue {
  [key: string]: unknown;
  code?: unknown;
  path?: PropertyKey[];
  input?: unknown;
  continue?: boolean;
  message?: unknown;
}

/** An issue as a failed parse reports it. */
export interface Issue {
  readonly [key: string]: unknown;
  readonly code: string;
  readonly path: PropertyKey[];
  readonly message: string;
}
