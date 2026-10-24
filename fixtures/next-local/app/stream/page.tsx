import { connection } from 'next/server';
import { type ReactNode, Suspense } from 'react';

const CHUNK_STEP_MS = 50;
const CHUNK_COUNT = 3;
const CHUNK_DELAYS_MS = Array.from({ length: CHUNK_COUNT }, (_, i) => (i + 1) * CHUNK_STEP_MS);

/** A boundary that settles after a wait, so the document arrives in several pieces. */
async function Late({ delayMs }: { readonly delayMs: number }): Promise<ReactNode> {
  await connection();
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
  return <p className="late">{`chunk after ${delayMs}ms`}</p>;
}

/** Streaming: the shell first, then three boundaries in the order they settle. */
export default function StreamPage(): ReactNode {
  return (
    <main>
      <h1 id="shell">fixture stream</h1>
      {CHUNK_DELAYS_MS.map((delayMs) => {
        return (
          <Suspense key={delayMs} fallback={<p className="late">waiting {delayMs}ms</p>}>
            <Late delayMs={delayMs} />
          </Suspense>
        );
      })}
    </main>
  );
}
