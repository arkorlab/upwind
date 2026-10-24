import { cookies } from 'next/headers';
import { type ReactNode, Suspense } from 'react';

type Params = Promise<{ readonly id: string }>;

/** One member the build knows, so the route has a concrete prerender beside its class shell. */
export function generateStaticParams(): { id: string }[] {
  return [{ id: 'known' }];
}

async function Item({ params }: { readonly params: Params }): Promise<ReactNode> {
  const { id } = await params;
  const jar = await cookies();
  return <p id="item">{`item=${id} seen=${jar.get('seen')?.value ?? 'no'}`}</p>;
}

export default function ItemPage({ params }: { readonly params: Params }): ReactNode {
  return (
    <main>
      <h1 id="shell">fixture item</h1>
      <Suspense fallback={<p id="item">loading</p>}>
        <Item params={params} />
      </Suspense>
    </main>
  );
}
