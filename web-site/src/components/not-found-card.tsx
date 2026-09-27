import type { ReactNode } from 'react';

import { en } from '@/content/en.ts';
import { ja } from '@/content/ja.ts';
import { explicitLocalePath } from '@/lib/routes.ts';

/**
 * The 404, in both languages at once.
 *
 * A page that does not exist is the one page whose reader's language is genuinely unknown: there is
 * no locale in a URL that matched no route, and the global 404 is rendered outside the `[locale]`
 * layout entirely. Rather than guess, it says the same short thing twice and offers each language's
 * front page — which is also what makes one component serve both 404s.
 *
 * Each link asks for its own language by name (`explicitLocalePath`), because a link to `/` would be
 * negotiated and could answer in the other one — an English link that lands on Japanese is the
 * failure this card exists to avoid.
 *
 * Plain anchors, not `next/link`: the router prefetches the links it can see, and `/en` is a
 * redirect that writes down the language a visitor asked for. A link that recorded a choice by being
 * scrolled past would be a worse bug than the one above. The proxy refuses to write on a prefetch
 * either way; this is the same answer said twice, and a language change is a whole new document
 * regardless — `<html lang>` and every word inside it.
 */
export function NotFoundCard(): ReactNode {
  return (
    <main
      id="content"
      // The skip link and these 404s both point a fragment at this element. A `main` is not
      // focusable of itself, so without this the browser may move the viewport and leave the focus
      // where it was — on the link in the header, a keyboard reader's next Tab going nowhere useful.
      tabIndex={-1}
      className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 px-6 py-24"
    >
      <div lang="en">
        <h1 className="text-2xl font-semibold tracking-tight">{en.notFound.title}</h1>
        <p className="mt-2 text-sm text-muted">{en.notFound.body}</p>
        <a
          href={explicitLocalePath('en')}
          className="mt-2 inline-block text-sm underline underline-offset-4"
        >
          {en.notFound.home}
        </a>
      </div>
      <div lang="ja">
        <h2 className="text-2xl font-semibold tracking-tight">{ja.notFound.title}</h2>
        <p className="mt-2 text-sm text-muted">{ja.notFound.body}</p>
        <a
          href={explicitLocalePath('ja')}
          className="mt-2 inline-block text-sm underline underline-offset-4"
        >
          {ja.notFound.home}
        </a>
      </div>
    </main>
  );
}
