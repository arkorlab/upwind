import type { ReactNode } from 'react';

import type { Copy } from '@/content/copy.ts';
import { LICENSE_MIT_URL, NPM_URL, REPOSITORY_URL } from '@/lib/site.ts';

import { Prose } from './prose.tsx';

const FOOTER_LINK = 'underline-offset-4 hover:underline';

/**
 * The line at the bottom says what this site is, because it is the same thing it describes: a Next.js
 * application whose deployment bundle came out of `upwind build`.
 */
export function SiteFooter({ copy }: { readonly copy: Copy }): ReactNode {
  return (
    <footer className="mt-auto border-t border-border">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 text-sm text-muted">
        <p>
          <Prose>{copy.footer.builtWith}</Prose>
        </p>
        <p className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
          <a href={REPOSITORY_URL} className={FOOTER_LINK}>
            {copy.footer.repository}
          </a>
          <a href={NPM_URL} className={FOOTER_LINK}>
            {copy.footer.npm}
          </a>
          <a href={LICENSE_MIT_URL} className={FOOTER_LINK}>
            {copy.footer.licence}
          </a>
        </p>
      </div>
    </footer>
  );
}
