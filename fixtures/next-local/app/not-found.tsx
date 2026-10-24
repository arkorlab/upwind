import { headers } from 'next/headers';
import { type ReactNode, Suspense } from 'react';

/** What the request can say about a path that has no page: rendered, not served from a file. */
async function Asked(): Promise<ReactNode> {
  const requestHeaders = await headers();
  return <p id="asked">{`missing proxied=${requestHeaders.get('x-proxied') ?? 'no'}`}</p>;
}

export default function NotFound(): ReactNode {
  return (
    <main>
      <h1 id="not-found">fixture not found</h1>
      <Suspense fallback={<p id="asked">loading</p>}>
        <Asked />
      </Suspense>
    </main>
  );
}
