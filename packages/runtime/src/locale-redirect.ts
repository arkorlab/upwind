import { detectDomainLocale, getAcceptLanguageLocale, getCookieLocale } from '@next/routing';

import type { Store } from './store.ts';

type Config = Pick<Store['manifest']['config'], 'basePath' | 'i18n' | 'trailingSlash'>;
type I18n = NonNullable<Config['i18n']>;
type Domain = NonNullable<Parameters<typeof detectDomainLocale>[0]>[number];
const domainsByConfig = new WeakMap<I18n, Domain[]>();

/** A deployment's domain configuration is fixed; never rebuild its router shape per request. */
function domainsOf(i18n: I18n): Domain[] | undefined {
  if (i18n.domains === undefined) return undefined;
  let domains = domainsByConfig.get(i18n);
  if (domains === undefined) {
    domains = i18n.domains.map((entry) => {
      return {
        domain: entry.domain,
        defaultLocale: entry.defaultLocale,
        ...(entry.http === true && { http: true as const }),
        ...(entry.locales !== undefined && { locales: entry.locales }),
      };
    });
    domainsByConfig.set(i18n, domains);
  }
  return domains;
}

function isRoot(basePath: string, requested: string): boolean {
  const pathname =
    basePath !== '' && (requested === basePath || requested.startsWith(`${basePath}/`))
      ? requested.slice(basePath.length) || '/'
      : requested;
  // Next's denormalizePagePath also reads /index and /index/ as the root. Locale-prefixed roots
  // never enter negotiation: Next's router deliberately keeps their explicit locale.
  return pathname === '/' || pathname === '/index' || pathname === '/index/';
}

function domainRedirect(
  domain: Domain | undefined,
  preferred: string | undefined,
  domains: Domain[] | undefined,
): string | undefined {
  if (domain === undefined || preferred === undefined) return undefined;
  const destination = detectDomainLocale(domains, undefined, preferred);
  if (destination === undefined) return undefined;
  const isDefault = destination.defaultLocale === preferred;
  if (isDefault && destination.domain === domain.domain) return undefined;
  const scheme = destination.http === true ? 'http' : 'https';
  return `${scheme}://${destination.domain}/${isDefault ? '' : preferred}`;
}

/** Next.js's root locale negotiation, before its routing tables or middleware run. */
export function preferredLocaleRedirect(
  config: Config,
  url: URL,
  headers: Headers,
): string | undefined {
  const { i18n, basePath } = config;
  if (i18n === null || i18n === undefined || i18n.localeDetection === false) return undefined;
  if (!isRoot(basePath, url.pathname)) return undefined;
  const domains = domainsOf(i18n);
  const domain = detectDomainLocale(domains, url.hostname);
  let preferred: string | undefined;
  try {
    preferred = getAcceptLanguageLocale(headers.get('accept-language') ?? '', i18n.locales);
  } catch {
    // Next's getLocaleRedirect ignores an invalid Accept-Language header.
  }
  const redirect = domainRedirect(domain, preferred, domains);
  if (redirect !== undefined) return redirect;
  const fallback = domain?.defaultLocale ?? i18n.defaultLocale;
  const detected =
    domain?.defaultLocale ??
    getCookieLocale(headers.get('cookie') ?? undefined, i18n.locales) ??
    preferred ??
    i18n.defaultLocale;
  if (detected.toLowerCase() === fallback.toLowerCase()) return undefined;
  const slash = config.trailingSlash ? '/' : '';
  return `${basePath}/${detected}${slash}${url.search}${url.hash}`;
}
