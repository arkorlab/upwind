import type { ReactNode } from 'react';

/** Complete at build time: nothing to resume, and the Worker answers it on its own. */
export default function StaticPage(): ReactNode {
  return (
    <main>
      <h1 id="static">fixture static</h1>
    </main>
  );
}
