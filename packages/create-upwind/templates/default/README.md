# upwind app

A [Next.js](https://nextjs.org) application, run by [upwind](https://github.com/arkorlab/upwind).

```bash
pnpm dev
```

`pnpm dev` is `upwind dev`: upwind holds the port and hands every request to the project's own
Next.js development server — the same dev bundler, the same HMR, the same error overlay — except for
`/__upwind`, which upwind answers itself. Open
[http://localhost:3000/__upwind](http://localhost:3000/__upwind) to see what it says about the run;
it answers while the application is still compiling, and while a compile of it is failing.

Edit `app/page.tsx` and the page updates.

## Building

```bash
pnpm build
```

`pnpm build` is `upwind build`: the project's own `next build`, with the deployment adapter named. It
writes a deployment bundle under `.ppr-cdn/` — every route, prerender and static file by content,
and the Functions that run the application's code. `next.config.ts` names the same adapter, so a
plain `next build` from CI or from any other tool produces the same bundle.

One thing only `upwind build` does: bind this project's own storage for the build, so that a page
prerendering from `@stayingupwind/sdk` has a database to read. A plain `next build` publishes none,
and such a page fails there saying so.

There is no `start` script on purpose. What a deployment runs is the bundle, not a Node server of
this project's own.

## Scheduled work

Cron jobs are declared beside `next.config.ts`, in an `upwind.config.ts` (or `upwind.json`) of your
own:

```ts
export default {
  crons: [{ path: '/api/nightly', schedule: '0 3 * * *' }],
};
```

The build reads it, refuses a schedule it cannot run, and carries what it accepted into the bundle.

## Learn more

- [Next.js documentation](https://nextjs.org/docs)
- [Tailwind CSS](https://tailwindcss.com/docs) — already set up, in `app/globals.css`
