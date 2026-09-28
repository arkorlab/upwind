import type { ReactNode } from 'react';

/**
 * A sentence from the dictionary, with its backticks set as code.
 *
 * The copy on this site is full of names a reader types — `next build`, `upwind dev`, `.arkor/` —
 * and a paragraph that spelled them in the body face would be asking the reader to guess which words
 * are literal. Markdown's own notation is what the dictionaries are written in, and this is the whole
 * of the notation: one character, split on, alternating.
 *
 * Only `content/` is ever passed here, so there is no untrusted string and nothing to sanitise: the
 * parts are text nodes either way, never markup.
 */

const INLINE_CODE = 'rounded-sm bg-subtle px-1 py-0.5 font-mono text-[0.9em]';

export function Prose({ children }: { readonly children: string }): ReactNode {
  const parts = children.split('`');
  if (parts.length === 1) {
    return children;
  }
  return (
    <>
      {parts.map((part, index) =>
        // Odd parts sat between two backticks; even ones are the prose around them.
        index % 2 === 0 ? (
          part
        ) : (
          <code key={`${String(index)}:${part}`} className={INLINE_CODE}>
            {part}
          </code>
        ),
      )}
    </>
  );
}
