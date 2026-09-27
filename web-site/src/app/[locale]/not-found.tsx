import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { NotFoundCard } from '@/components/not-found-card.tsx';
import { en } from '@/content/en.ts';

/**
 * A path that matched `[locale]` but named no language — `/zz`, which the proxy never produces and a
 * hand-typed URL can. Rendered inside the root layout, so it is the site's own document rather than
 * the framework's bare one.
 *
 * With no metadata of its own it would inherit the layout's, and a 404 would go out titled and
 * described as the front page — the wrong thing in a tab, in a share, and in whatever a crawler
 * keeps of a page it should not have indexed. The status code says the rest; this says it too.
 */

export const metadata: Metadata = {
  title: en.meta.siteName,
  description: undefined,
  robots: { index: false, follow: false },
};

export default function NotFound(): ReactNode {
  return <NotFoundCard />;
}
