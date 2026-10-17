import type { RouteEntryDescriptor } from '@stayingupwind/core/cache';
import type { ResourceWarmProps } from '@stayingupwind/core/paas';

function fields(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** This operation is selected by trusted dispatch props, never by a URL or request header. */
export function resourceWarmOf(props: unknown): ResourceWarmProps['resourceWarm'] | undefined {
  if (!fields(props) || !fields(props['resourceWarm'])) return undefined;
  const warm = props['resourceWarm'];
  const entry = warm['entry'];
  if (
    warm['v'] !== 1 ||
    typeof warm['scopeId'] !== 'string' ||
    warm['scopeId'].length === 0 ||
    !fields(entry) ||
    !['app-page', 'app-route', 'pages'].includes(entry['kind'] as string) ||
    typeof entry['route'] !== 'string' ||
    !entry['route'].startsWith('/') ||
    typeof entry['pathname'] !== 'string' ||
    !entry['pathname'].startsWith('/')
  )
    return undefined;
  return {
    v: 1,
    scopeId: warm['scopeId'],
    entry: {
      kind: entry['kind'] as RouteEntryDescriptor['kind'],
      route: entry['route'],
      pathname: entry['pathname'],
    },
  };
}
