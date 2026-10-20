import { describe, expect, it } from 'vitest';

import { fallbackBundle, FALLBACK_MEMBER } from '../../core/test/fallback-pages-fixtures.ts';
import { staticPagesRuntimeFields } from '../src/static-pages.ts';

describe('the Pages runtime capability', () => {
  it('carries explicit fallback authority into a Function with a native loading class', () => {
    expect(staticPagesRuntimeFields(fallbackBundle())).toStrictEqual({ staticPagesPrivacy: 3 });
  });

  it('keeps a purely immutable fixed page runtime unmarked', () => {
    const page = {
      ...FALLBACK_MEMBER,
      route: '/fixed',
      pathname: '/fixed',
      initialRevalidate: false as const,
      initialExpiration: undefined,
      allowQuery: [],
    };
    const bundle = fallbackBundle({
      prerenders: [page],
      entrypoints: [{ id: 'page', kind: 'pages', pathname: '/fixed' }],
    });

    expect(staticPagesRuntimeFields(bundle)).toStrictEqual({});
    expect(
      staticPagesRuntimeFields({ ...bundle, prerenders: [{ ...page, initialRevalidate: 2 }] }),
    ).toStrictEqual({ staticPagesPrivacy: 3 });
  });

  it('does not grant fallback runtime capability to unsupported locale routing', () => {
    const bundle = fallbackBundle();

    expect(
      staticPagesRuntimeFields({
        ...bundle,
        config: { ...bundle.config, i18n: { locales: ['en'], defaultLocale: 'en' } },
      }),
    ).toStrictEqual({});
  });
});
