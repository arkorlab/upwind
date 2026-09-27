import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

import { NotFoundCard } from '@/components/not-found-card.tsx';
import { en } from '@/content/en.ts';

/**
 * The 404 for a URL that matched no route at all.
 *
 * This site's root layout is under `[locale]`, so there is no layout above a URL like `/a/b` to
 * render a 404 inside — which is what `experimental.globalNotFound` and this file are for
 * (Next.js, "not-found"). It is a whole document, and it carries the stylesheet itself.
 */

export const metadata: Metadata = {
  title: en.meta.siteName,
  robots: { index: false, follow: false },
};

export default function GlobalNotFound(): ReactNode {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col antialiased">
        <NotFoundCard />
      </body>
    </html>
  );
}
