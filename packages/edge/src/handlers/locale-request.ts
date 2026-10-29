import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { type LocaleRequest, localeRequestOf } from '@stayingupwind/core/paas';
import { type HostCredentials, withoutHostCredentials } from '@stayingupwind/host/credentials';

/** Inspect no headers or cookie values unless this is a possible Pages-i18n root. */
export function rootLocaleRequest(
  manifest: Pick<ProjectManifest, 'spelledPrefix' | 'middleware'>,
  url: URL,
  headers: Headers,
  credentials: HostCredentials,
): LocaleRequest | undefined {
  const prefix = manifest.spelledPrefix;
  if (prefix?.locales === undefined || manifest.middleware === undefined) return undefined;
  const { basePath } = prefix;
  const path =
    basePath !== '' && (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))
      ? url.pathname.slice(basePath.length) || '/'
      : url.pathname;
  if (path !== '/' && path !== '/index' && path !== '/index/') return undefined;
  return localeRequestOf(withoutHostCredentials(new Headers(headers), credentials));
}
