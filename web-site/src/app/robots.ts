import type { MetadataRoute } from 'next';

import { SITE_URL } from '@/lib/site.ts';

/**
 * Everything here is meant to be read, so nothing is disallowed. The one thing worth saying is where
 * the sitemap is, absolutely — a crawler that found this file on the apex would otherwise be told
 * about a sitemap on a host that redirects.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: new URL('/sitemap.xml', SITE_URL).href,
  };
}
