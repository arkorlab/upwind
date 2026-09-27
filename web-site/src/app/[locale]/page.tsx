import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Prose } from '@/components/prose.tsx';
import { SiteFooter } from '@/components/site-footer.tsx';
import { SiteHeader } from '@/components/site-header.tsx';
import type { Copy, Term } from '@/content/copy.ts';
import { dictionary } from '@/content/dictionary.ts';
import { frameLocale, resolveLocale } from '@/i18n/resolve-locale.ts';
import { buildPageMetadata } from '@/lib/metadata.ts';
import {
  CONTRIBUTING_URL,
  CREATE_COMMAND,
  ISSUES_URL,
  LICENSE_APACHE_URL,
  LICENSE_MIT_URL,
  npmUrl,
  NPM_URL,
  PACKAGES,
  readmeUrl,
  REPOSITORY_URL,
  SUPPORTED_NEXT_RANGE,
} from '@/lib/site.ts';

/**
 * The whole site: one page, in one of two languages, rendered from the dictionary it is handed.
 *
 * Every section is a heading, a paragraph and a list of terms, because that is the shape of what
 * there is to say — what a build writes, what the front door answers, what the bundle serves. The
 * page holds no facts of its own: the words come from `content/`, the names and links from
 * `lib/site.ts`.
 */

const SECTION = 'mt-20 sm:mt-28';
const SECTION_TITLE = 'text-2xl font-semibold tracking-tight text-balance sm:text-3xl';
const SECTION_BODY = 'mt-5 max-w-2xl text-base/relaxed text-muted';
const TERM = 'font-semibold';
const DESCRIPTION = 'mt-1.5 text-sm/relaxed text-muted';
const INLINE_LINK = 'underline underline-offset-4';
const SMALL_LINK = 'text-xs underline-offset-4 hover:underline';

/**
 * The arrow that follows a link's words. The space before it is a non-breaking one, so the arrow
 * never begins a line of its own — and JSX would have eaten an ordinary one at the tag boundary.
 */
function Arrow(): ReactNode {
  return <span aria-hidden="true">{'\u00a0→'}</span>;
}

/**
 * A section's term list: the same two lines whether the terms are files, paths or capabilities.
 *
 * The class list is one whole string. Tailwind finds the classes it must generate by reading this
 * file as text, and a name built by interpolation — `gap-y-8${…}` — is a name it cannot see the end
 * of, so the utility is silently never emitted and the layout is off by exactly the rule that does
 * not exist.
 */
function Terms({ items }: { readonly items: readonly Term[] }) {
  return (
    <dl className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.term}>
          <dt className={TERM}>
            <Prose>{item.term}</Prose>
          </dt>
          <dd className={DESCRIPTION}>
            <Prose>{item.description}</Prose>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Hero({ copy }: { readonly copy: Copy }): ReactNode {
  return (
    <section className="pt-14 sm:pt-20">
      <h1 className="tracking-tight">
        <span className="block font-mono text-sm font-semibold">upwind</span>
        <span className="mt-5 block text-3xl/[1.15] font-semibold text-balance sm:text-4xl/[1.1]">
          {copy.hero.tagline}
        </span>
      </h1>
      <p className="mt-6 max-w-2xl text-base/relaxed text-muted">
        <Prose>{copy.hero.body}</Prose>
      </p>
      <p className="mt-10 text-sm text-muted">{copy.hero.commandCaption}</p>
      <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-subtle px-4 py-3">
        <code className="font-mono text-sm">{CREATE_COMMAND}</code>
      </pre>
      <p className="mt-2 text-sm text-muted">{copy.hero.commandNote}</p>
      <p className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm font-semibold">
        <a
          href={REPOSITORY_URL}
          className="inline-flex min-h-11 items-center rounded-md bg-inverse-bg px-5 text-inverse-fg hover:bg-gray-700 dark:hover:bg-gray-300"
        >
          {copy.hero.primary}
          <Arrow />
        </a>
        <a
          href={NPM_URL}
          className="inline-flex min-h-11 items-center underline underline-offset-4"
        >
          {copy.hero.secondary}
          <Arrow />
        </a>
      </p>
    </section>
  );
}

function Bundle({ copy }: { readonly copy: Copy }): ReactNode {
  return (
    <section aria-labelledby="bundle-title" className={SECTION}>
      <h2 id="bundle-title" className={SECTION_TITLE}>
        {copy.bundle.title}
      </h2>
      <p className={SECTION_BODY}>
        <Prose>{copy.bundle.body}</Prose>
      </p>
      <Terms items={copy.bundle.items} />
      <p className="mt-8 border-l border-border pl-4 text-sm/relaxed text-muted">
        <Prose>{copy.bundle.note}</Prose>
      </p>
    </section>
  );
}

function Development({ copy }: { readonly copy: Copy }): ReactNode {
  return (
    <section aria-labelledby="dev-title" className={SECTION}>
      <h2 id="dev-title" className={SECTION_TITLE}>
        {copy.dev.title}
      </h2>
      <p className={SECTION_BODY}>
        <Prose>{copy.dev.body}</Prose>
      </p>
      <Terms items={copy.dev.endpoints} />
      <p className="mt-8 border-l border-border pl-4 text-sm/relaxed text-muted">
        <Prose>{copy.dev.note}</Prose>
      </p>
    </section>
  );
}

function Serves({ copy }: { readonly copy: Copy }): ReactNode {
  return (
    <section aria-labelledby="serves-title" className={SECTION}>
      <h2 id="serves-title" className={SECTION_TITLE}>
        {copy.serves.title}
      </h2>
      <p className={SECTION_BODY}>
        <Prose>{copy.serves.body}</Prose>
      </p>
      <Terms items={copy.serves.items} />
      <div className="mt-10 rounded-md border border-border p-5">
        <p className="font-mono text-sm font-semibold">
          {copy.serves.rangeLabel} {SUPPORTED_NEXT_RANGE}
        </p>
        <p className={DESCRIPTION}>{copy.serves.rangeNote}</p>
      </div>
    </section>
  );
}

function Packages({ copy }: { readonly copy: Copy }): ReactNode {
  return (
    <section aria-labelledby="packages-title" className={SECTION}>
      <h2 id="packages-title" className={SECTION_TITLE}>
        {copy.packages.title}
      </h2>
      <p className={SECTION_BODY}>
        <Prose>{copy.packages.body}</Prose>
      </p>
      <ul className="mt-8 divide-y divide-border border-y border-border">
        {PACKAGES.map((entry) => (
          <li key={entry.id} className="py-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <code className="font-mono text-sm font-semibold">{entry.name}</code>
              <span className="flex gap-4">
                <a href={npmUrl(entry.name)} className={SMALL_LINK}>
                  {copy.packages.npmLabel}
                </a>
                <a href={readmeUrl(entry.directory)} className={SMALL_LINK}>
                  {copy.packages.readmeLabel}
                </a>
              </span>
            </div>
            <p className={DESCRIPTION}>
              <Prose>{copy.packages.summaries[entry.id]}</Prose>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Status({ copy }: { readonly copy: Copy }): ReactNode {
  const { licence } = copy.status;
  return (
    <section aria-labelledby="status-title" className={SECTION}>
      <h2 id="status-title" className={SECTION_TITLE}>
        {copy.status.title}
      </h2>
      <p className={SECTION_BODY}>
        <Prose>{copy.status.body}</Prose>
      </p>
      <ul className="mt-8 max-w-2xl space-y-3 text-sm/relaxed text-muted">
        {copy.status.points.map((point) => (
          <li key={point} className="border-l border-border pl-4">
            <Prose>{point}</Prose>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-sm text-muted">
        {licence.label}:{' '}
        <a href={LICENSE_MIT_URL} className={INLINE_LINK}>
          MIT
        </a>{' '}
        {licence.conjunction}{' '}
        <a href={LICENSE_APACHE_URL} className={INLINE_LINK}>
          Apache-2.0
        </a>
        {licence.note}
      </p>
      <p className="mt-6 flex flex-wrap gap-x-6 gap-y-3 text-sm font-semibold">
        <a href={CONTRIBUTING_URL} className={INLINE_LINK}>
          {copy.status.contributing}
          <Arrow />
        </a>
        <a href={ISSUES_URL} className={INLINE_LINK}>
          {copy.status.issues}
          <Arrow />
        </a>
      </p>
    </section>
  );
}

export async function generateMetadata(props: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<Metadata> {
  // The page below refuses a segment that is not a locale; metadata for one it would refuse is
  // metadata nobody reads, so this takes the default rather than throwing from here.
  const locale = frameLocale((await props.params).locale);
  const copy = dictionary(locale);
  return buildPageMetadata({
    locale,
    title: copy.meta.title,
    description: copy.meta.description,
    siteName: copy.meta.siteName,
    imageAlt: copy.meta.ogImageAlt,
  });
}

export default async function Home(props: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactNode> {
  const locale = resolveLocale((await props.params).locale);
  const copy = dictionary(locale);
  return (
    <>
      <SiteHeader locale={locale} copy={copy} />
      <main id="content" className="mx-auto w-full max-w-3xl px-6 pb-24">
        <Hero copy={copy} />
        <Bundle copy={copy} />
        <Development copy={copy} />
        <Serves copy={copy} />
        <Packages copy={copy} />
        <Status copy={copy} />
      </main>
      <SiteFooter copy={copy} />
    </>
  );
}
