import type { SpelledPrefix } from '../manifest/schema.ts';
import type { DeploymentBundle } from './schema.ts';

/**
 * What the build's router reads of a request's path as it is written, before it decodes anything
 * (`spellsPrefixOf`): its base path, and in an application with `i18n`, the locale behind it —
 * every locale it routes, its domains' as well, which is what `normalizeLocalePath` is handed.
 * `undefined` for an application with neither, whose router reads nothing so. Of a bundle, for a
 * deploy to write into the manifest, and of the runtime's own copy of its configuration, for a
 * Function to read a path by.
 */
export function spelledPrefixOf(
  bundle: Pick<DeploymentBundle, 'config'>,
): SpelledPrefix | undefined {
  const { basePath, i18n } = bundle.config;
  if (i18n === null || i18n === undefined) {
    return basePath === '' ? undefined : { basePath };
  }
  const { domains = [] } = i18n;
  const named = domains.flatMap((domain) => [domain.defaultLocale, ...(domain.locales ?? [])]);
  const routed = new Set(i18n.locales);
  for (const locale of named) {
    routed.add(locale);
  }
  const locales = [...routed].filter((locale) => locale !== '');
  if (locales.length === 0) {
    return basePath === '' ? undefined : { basePath };
  }
  return { basePath, locales };
}
