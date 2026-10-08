# create-upwind

```bash
pnpm create upwind
```

Writes a Next.js application that [upwind](https://www.npmjs.com/package/upwind) can run, and
installs it.

```
my-upwind-app
├── .gitignore
├── AGENTS.md
├── app/
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── next.config.ts
├── package.json
├── postcss.config.mjs
├── tsconfig.json
└── README.md
```

```jsonc
{
  "scripts": {
    "dev": "upwind dev",
    "build": "upwind build"
  },
  "dependencies": { "next": "…", "react": "…", "react-dom": "…" },
  "devDependencies": { "upwind": "…", "@stayingupwind/adapter": "…", "tailwindcss": "…", … }
}
```

## What it wires, and why

**Next.js, React and React DOM are dependencies of the application.** upwind is not a framework and
carries no copy of one: `upwind dev` resolves Next.js _from the project_ and refuses to start without
it. An application upwind can run is one that has Next.js of its own, which is what this writes.

**`upwind` and `@stayingupwind/adapter` come from one release.** `create-upwind@x.y.z` asks for
`^x.y.z` of both, and they are published from one tag — so what scaffolds a project and what runs it
are of the same generation.

**The adapter is named twice, on purpose.** `package.json` runs builds through `upwind build`, which
names the adapter in the environment; and `next.config.ts` names it too, so a plain `next build` —
from CI, from a script, from anything that has never heard of upwind — writes the same deployment
bundle.

**Tailwind 4 is set up** (`@import "tailwindcss";` and a PostCSS plugin, no config file). Nothing
else is: no ESLint, no `src/`, no component library. `create-next-app --empty` is the shape.

**`AGENTS.md` is Next.js's, word for word.** It carries the block Next.js writes to tell a coding
agent that this major is not the one it was trained on, and where in `node_modules/next/dist/docs/`
to read before writing any code — the same file `create-next-app` writes, from the same text. Until
Next.js 16.4 that was two files, with a `CLAUDE.md` importing `AGENTS.md`; 16.4 writes `AGENTS.md`
alone, and so does this.

Keeping it identical is the point, so this scaffolder tries not to be the last word on it. The text
it was built against is written first; then, where the install left a Next.js it can reach, that one
is asked to write its own, before the first commit — so a project made after a release that words
the block differently is committed with that release's wording rather than this one's.

Where there is nothing to reach, the text this release carries is what the project keeps until the
first `upwind dev` corrects it. Under `--skip-install` there is no install to ask and nothing is
said, which is the flag doing what it says. After an install that left nothing this can read — a
Yarn Plug'n'Play project keeps its packages zipped, where a plain Node process cannot open them —
it says so before it finishes.

`upwind dev` asks the same question on any start where it finds a coding agent, which is the only
kind of start the answer matters on, so a project stays current as its Next.js moves — and a plain
`next dev` then agrees with what is already there instead of rewriting it.

`--no-agents-md` leaves it out — and the first `upwind dev` an agent runs writes it, because that is
what the project's Next.js does about a missing block, and `next dev` would do it too. The switch
that lasts is Next.js's own: `agentRules: false` in `next.config.ts`, which both commands obey.

## Options

```
pnpm create upwind [directory]

      --skip-install  Write the application, install nothing
      --no-git        Do not make a first commit
      --no-agents-md  Do not write AGENTS.md
      --use-npm       Install with npm
      --use-pnpm      Install with pnpm
      --use-yarn      Install with yarn
      --use-bun       Install with bun
  -v, --version       Print create-upwind's version
  -h, --help          Print the usage
      --              Everything after this is the directory, even `--help`
```

Given no directory it asks for one — once, because there is one template and nothing else to decide.
Asked from something that is not a terminal (a script, a CI job, `< /dev/null`) it takes
`my-upwind-app` rather than waiting for an answer that is not coming.

The install runs with the package manager this was started from — `pnpm create` installs with pnpm,
`npm create` with npm — as `npm_config_user_agent` reports it, unless a `--use-*` says otherwise. The
first commit comes after the install, so the lockfile is in it.

## Licence

MIT or Apache-2.0, at your option.
