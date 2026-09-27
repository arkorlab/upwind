import type { ReactNode } from 'react';

import { NotFoundCard } from '@/components/not-found-card.tsx';

/**
 * A path that matched `[locale]` but named no language — `/zz`, which the proxy never produces and a
 * hand-typed URL can. Rendered inside the root layout, so it is the site's own document rather than
 * the framework's bare one.
 */
export default function NotFound(): ReactNode {
  return <NotFoundCard />;
}
