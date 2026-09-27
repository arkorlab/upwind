import { ImageResponse } from 'next/og';

import { en } from '@/content/en.ts';
import { locales } from '@/i18n/locales.ts';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from '@/lib/metadata.ts';

/**
 * The card a link to this site unfurls into — rendered by the Function that serves the site, which is
 * one of the things the page claims upwind can do.
 *
 * **Latin only, in both locales.** `next/og` draws with the font it carries, which has no Japanese
 * glyphs: a Japanese line here would come out as a row of empty boxes in every feed that showed it.
 * So the card is the wordmark, the English tagline and the site's own name, and the Japanese page
 * shares the same picture with a Japanese `og:image:alt` beside it (`lib/metadata.ts`).
 */

/**
 * What this route says about itself, for a reader of the route rather than of the page.
 *
 * It is not what goes out in the `og:image:alt` of either page: a page that sets `openGraph.images`
 * itself — which `buildPageMetadata` does, with the alt from that page's own dictionary — is the one
 * that wins, so `/ja` carries the Japanese sentence and `/` the English one. Worth knowing because
 * the precedence runs the other way when a page leaves its images unset, and this export is the
 * English one.
 */
export const alt = en.meta.ogImageAlt;
export const size = { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT };
export const contentType = 'image/png';

/**
 * The layout's own params do not reach a metadata route, and without these the card is rendered on
 * demand — a PNG drawn again for every crawler that asks. Both locales draw the same picture, so both
 * are prerendered and served from storage.
 */
export function generateStaticParams(): { locale: string }[] {
  return locales.map((locale) => ({ locale }));
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * The dark end of `globals.css`, in hex.
 *
 * The renderer behind `ImageResponse` parses a small CSS of its own and refuses `oklch()` — a build
 * that prerenders this card is what says so, where a card rendered on demand would have failed in
 * front of a crawler instead. These are the same three greys as the stylesheet's, converted.
 */
const INK = '#0a0a0a';
const PAPER = '#fafafa';
const MUTED = '#a3a3a3';

export default function Image(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: INK,
        color: PAPER,
        padding: '80px',
      }}
    >
      <div style={{ display: 'flex', fontFamily: MONO, fontSize: 40, letterSpacing: '-0.02em' }}>
        upwind
      </div>
      <div style={{ display: 'flex', fontSize: 68, lineHeight: 1.15, letterSpacing: '-0.03em' }}>
        {en.hero.tagline}
      </div>
      <div style={{ display: 'flex', fontFamily: MONO, fontSize: 30, color: MUTED }}>
        www.stayingupwind.com
      </div>
    </div>,
    size,
  );
}
