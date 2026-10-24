import { cookies, headers } from 'next/headers';
import { type ReactNode, Suspense } from 'react';

/** The part the shell leaves out: what only the request can say. */
async function Visitor(): Promise<ReactNode> {
  const jar = await cookies();
  const requestHeaders = await headers();
  return (
    <p id="visitor">
      {`seen=${jar.get('seen')?.value ?? 'no'} proxied=${requestHeaders.get('x-proxied') ?? 'no'}`}
    </p>
  );
}

export default function HomePage(): ReactNode {
  return (
    <main>
      <h1 id="shell">fixture home</h1>
      <Suspense fallback={<p id="visitor">loading</p>}>
        <Visitor />
      </Suspense>
    </main>
  );
}
