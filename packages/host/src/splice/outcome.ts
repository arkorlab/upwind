/** Where the splice was when it ended: waiting on the resume, or streaming its suffix. */
export type SplicePhase = 'head' | 'suffix';

export type SpliceOutcome =
  | {
      readonly kind: 'ok';
      readonly suffixBytes: number;
      readonly originFirstByteMs: number;
      readonly totalMs: number;
    }
  /**
   * The resumed part carried a `Set-Cookie`. The response headers were committed before the render
   * began, so the cookie cannot be forwarded; serving the document would silently drop it. `names`
   * is what arrived — names only, never values.
   */
  | {
      readonly kind: 'set-cookie-observed';
      readonly names: readonly string[];
      readonly recovered: boolean;
    }
  /** A response header requires browser behavior the already committed shell cannot preserve. */
  | {
      readonly kind: 'behavioral-header-observed';
      readonly header: string;
      readonly recovered: boolean;
    }
  /**
   * The resume closed cleanly without reaching `</body></html>`: what the client holds is a
   * truncated page, not a complete one.
   */
  | {
      readonly kind: 'unterminated';
      readonly forwarded: number;
      readonly receivedSuffixBytes: number;
      readonly recovered: boolean;
    }
  | {
      readonly kind: 'upstream-error';
      readonly phase: SplicePhase;
      readonly forwarded: number;
      readonly detail: string;
      readonly recovered: boolean;
    }
  | {
      readonly kind: 'bad-upstream-response';
      readonly status: number;
      /**
       * The opening of what the application answered with, where it could be read.
       *
       * Kept because a status alone does not say why: an error page usually says something in its
       * body, and a deployment that answers 500 on every route is otherwise left to guesses.
       * Bounded hard and taken only on this failure, which is already a failure.
       */
      readonly body: string | undefined;
      /**
       * The names of the headers it came with, sorted and comma-joined.
       *
       * Kept because the body does not settle it either: `Internal Server Error` is what the
       * runtime's own catch answers with and also what a host may answer for a Worker that never
       * ran, and a 500 whose first byte arrives too fast for a render to have failed leaves both
       * readings open. The three candidates carry different headers and nothing else tells them
       * apart: a host's own 500 carries almost none, the runtime's `new Response` carries what
       * workerd adds to it, and a rendered error page carries Next.js's. Names only, never values.
       */
      readonly headers: string | undefined;
      readonly recovered: boolean;
    }
  | {
      readonly kind: 'timeout';
      readonly phase: SplicePhase;
      readonly forwarded: number;
      readonly recovered: boolean;
    }
  | { readonly kind: 'client-cancelled'; readonly forwarded: number };
