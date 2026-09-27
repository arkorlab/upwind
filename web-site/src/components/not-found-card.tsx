import Link from 'next/link';
import type { ReactNode } from 'react';

import { en } from '@/content/en.ts';
import { ja } from '@/content/ja.ts';
import { localePath } from '@/lib/routes.ts';

/**
 * The 404, in both languages at once.
 *
 * A page that does not exist is the one page whose reader's language is genuinely unknown: there is
 * no locale in a URL that matched no route, and the global 404 is rendered outside the `[locale]`
 * layout entirely. Rather than guess, it says the same short thing twice and offers each language's
 * front page — which is also what makes one component serve both 404s.
 */
export function NotFoundCard(): ReactNode {
  return (
    <main
      id="content"
      className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 px-6 py-24"
    >
      <div lang="en">
        <h1 className="text-2xl font-semibold tracking-tight">{en.notFound.title}</h1>
        <p className="mt-2 text-sm text-muted">{en.notFound.body}</p>
        <Link
          href={localePath('en')}
          className="mt-2 inline-block text-sm underline underline-offset-4"
        >
          {en.notFound.home}
        </Link>
      </div>
      <div lang="ja">
        <h2 className="text-2xl font-semibold tracking-tight">{ja.notFound.title}</h2>
        <p className="mt-2 text-sm text-muted">{ja.notFound.body}</p>
        <Link
          href={localePath('ja')}
          className="mt-2 inline-block text-sm underline underline-offset-4"
        >
          {ja.notFound.home}
        </Link>
      </div>
    </main>
  );
}
