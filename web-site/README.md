# web-site

[www.stayingupwind.com](https://www.stayingupwind.com) — one page, in English at `/` and Japanese at
`/ja`.

A Next.js application of its own: written by `create-upwind`, built by `upwind build`, and served
from the deployment bundle that build writes. That is the point of it being here — the adapter the
page describes is the adapter that shipped the page.

```bash
pnpm install
pnpm dev        # upwind dev, on http://localhost:3000
pnpm build      # upwind build, writes .ppr-cdn/
pnpm typecheck  # tsc; `next build` type-checks too
```

## Not a workspace package

This directory is deliberately outside the repository's pnpm workspace, as `fixtures/` is. It
depends on the **published** `upwind` and `@stayingupwind/adapter`, so the site is built by a release
rather than by whatever is uncommitted next door, and `pnpm-workspace.yaml` here is what makes pnpm
treat it as its own project — its own lockfile, its own `node_modules`.

What follows from that: the repository's `pnpm lint`, `pnpm knip` and `pnpm typecheck` do not reach
this directory (its own `tsc` and `next build` are what check it), and `pnpm format` does — oxfmt
formats these files with the repository's settings, and sorts the Tailwind classes against
`src/app/globals.css`.

## What is where

| Path                 | What it holds                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/[locale]/`  | The root layout and the page. The segment is the language, and `generateStaticParams` prerenders both of them                                 |
| `src/proxy.ts`       | The only Function that runs per request: `/en/…` → the bare path (recording the choice), `/ja/…` as it stands, and a bare path to one of them |
| `src/content/`       | Every word on the screen: one interface, two dictionaries the type holds to each other                                                        |
| `src/i18n/`          | The locales, `Accept-Language` negotiation, and the narrowing of the `[locale]` segment                                                       |
| `src/lib/`           | The site's own facts (`site.ts`), locale paths, and the metadata every page is built from                                                     |
| `src/components/`    | The header, the footer, the language switch, and the backtick-to-`<code>` renderer                                                            |
| `src/app/sitemap.ts` | Both pages with their hreflang alternates; `robots.ts` beside it names the sitemap absolutely                                                 |

## Changing the copy

`src/content/copy.ts` is the interface and `en.ts` / `ja.ts` are the two objects that satisfy it, so
a string added to one and forgotten in the other is a type error rather than a page that quietly
falls back to English. Backticks are inline code (`src/components/prose.tsx`); names a reader types —
`next build`, `.ppr-cdn/` — stay in the dictionary in both languages, because they are the same name
in both.

Tailwind finds the utilities it must generate by reading these files as text. Write whole class
names: a name assembled with interpolation is one it cannot see, and the rule is silently never
emitted.

The package table is `PACKAGES` in `src/lib/site.ts`, and it follows **npm**, not `packages/`: this
site is deployed when a change lands on `main`, and a package the repository has but a release has
not published yet would be a row linking to a 404. A release that publishes one adds the row, and
that is the whole edit — no sentence counts the packages.

## Deployment

Arkor builds `main` from GitHub — root directory `web-site`, `pnpm install --frozen-lockfile`,
`pnpm build`, and the bundle it serves is `.ppr-cdn/`. Nothing about that lives in this repository:
there are no credentials here and no workflow that deploys.

The canonical host is `www.stayingupwind.com` and the apex redirects to it, so every absolute URL the
site emits — canonical, hreflang, the sitemap, the Open Graph card — names `www` (`src/lib/site.ts`).
