import type { PackageId } from '@/lib/site.ts';

/**
 * Every word this site puts on a screen.
 *
 * One interface, two objects that satisfy it (`en.ts`, `ja.ts`), and a page that renders whichever it
 * is handed. The type is the whole of the checking: both dictionaries are literals in the same build,
 * so a string added to one and forgotten in the other is a type error rather than a page that falls
 * back to English in front of a reader.
 *
 * What is *not* here: package names, paths, versions and commands. `upwind build`, `/__upwind` and
 * `.ppr-cdn/` are spelled the same in every language, and a name that can be translated by accident
 * is a name that will be.
 */

export interface Term {
  /** Names a thing, and is often code; the page decides whether it is set in the mono face. */
  readonly term: string;
  readonly description: string;
}

export interface Copy {
  readonly meta: {
    readonly title: string;
    readonly description: string;
    readonly siteName: string;
    readonly ogImageAlt: string;
  };
  readonly nav: {
    readonly skipToContent: string;
    readonly repository: string;
    readonly npm: string;
    /** The switch's accessible name, and the other language's name written in that language. */
    readonly language: { readonly label: string; readonly target: string };
  };
  readonly hero: {
    readonly tagline: string;
    readonly body: string;
    readonly commandCaption: string;
    readonly commandNote: string;
    readonly primary: string;
    readonly secondary: string;
  };
  readonly bundle: {
    readonly title: string;
    readonly body: string;
    readonly items: readonly Term[];
    readonly note: string;
  };
  readonly dev: {
    readonly title: string;
    readonly body: string;
    readonly endpoints: readonly Term[];
    readonly note: string;
  };
  readonly serves: {
    readonly title: string;
    readonly body: string;
    readonly items: readonly Term[];
    readonly rangeLabel: string;
    readonly rangeNote: string;
  };
  readonly packages: {
    readonly title: string;
    readonly body: string;
    readonly summaries: Readonly<Record<PackageId, string>>;
    readonly npmLabel: string;
    readonly readmeLabel: string;
  };
  readonly status: {
    readonly title: string;
    readonly body: string;
    readonly points: readonly string[];
    /** `MIT` and `Apache-2.0` are their own names; these are the words around them. */
    readonly licence: {
      readonly label: string;
      readonly conjunction: string;
      readonly note: string;
    };
    readonly contributing: string;
    readonly issues: string;
  };
  readonly footer: {
    readonly builtWith: string;
    readonly repository: string;
    readonly npm: string;
    readonly licence: string;
  };
  readonly notFound: {
    readonly title: string;
    readonly body: string;
    readonly home: string;
  };
}
