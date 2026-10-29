import { detectDomainLocale } from '@next/routing';

import { preferredLanguage } from './locale-language.ts';
import type { RoutedInput } from './serve.ts';
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
  // Next negotiates bare `/` before rejecting paths outside a configured basePath.
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

/** Next's cookie parser decodes the first named value, including quoted values. */
function cookieLocale(header: string | null, locales: readonly string[]): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1 || part.slice(0, at).trim() !== 'NEXT_LOCALE') continue;
    let value = part.slice(at + 1).trim();
    if (value.startsWith('"')) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // The cookie parser leaves malformed escapes unchanged.
    }
    const normalized = value.toLowerCase();
    return locales.find((locale) => locale.toLowerCase() === normalized);
  }
  return undefined;
}

/** Next.js's root locale negotiation, before its routing tables or middleware run. */
export function preferredLocaleRedirect(
  config: Config,
  url: URL,
  headers: Headers,
  original?: Pick<RoutedInput, 'initURL' | 'localeRequest'>,
): string | undefined {
  const { i18n, basePath } = config;
  if (i18n === null || i18n === undefined || i18n.localeDetection === false) return undefined;
  // The edge can already have rewritten the request. Negotiate on the client's URL, before that
  // middleware decision, rather than interpreting its destination as a new root request.
  const { initURL, localeRequest } = original ?? {};
  const requested = initURL === undefined || initURL === url.href ? url : new URL(initURL, url);
  if (!isRoot(basePath, requested.pathname)) return undefined;
  const domains = domainsOf(i18n);
  const domain = detectDomainLocale(domains, requested.hostname);
  const language =
    localeRequest === undefined ? headers.get('accept-language') : localeRequest.language;
  const preferred = preferredLanguage(language ?? '', i18n.locales);
  const redirect = domainRedirect(domain, preferred, domains);
  if (redirect !== undefined) return redirect;
  const fallback = domain?.defaultLocale ?? i18n.defaultLocale;
  const cookie = localeRequest === undefined ? headers.get('cookie') : localeRequest.cookie;
  const detected =
    domain?.defaultLocale ?? cookieLocale(cookie, i18n.locales) ?? preferred ?? i18n.defaultLocale;
  if (detected.toLowerCase() === fallback.toLowerCase()) return undefined;
  const slash = config.trailingSlash ? '/' : '';
  return `${basePath}/${detected}${slash}${requested.search}${requested.hash}`;
}
