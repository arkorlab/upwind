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
├── CLAUDE.md
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

**`AGENTS.md` and `CLAUDE.md` are Next.js's, word for word.** They carry the block Next.js writes to
tell a coding agent that this major is not the one it was trained on, and where in
`node_modules/next/dist/docs/` to read before writing any code — the same two files
`create-next-app` writes, from the same text. Keeping it identical is the point: `upwind dev` asks
the project's own Next.js to bring the block up to date, so a project upgraded to a Next.js that
words it differently is re-worded rather than left behind, and a plain `next dev` agrees with what
is already there. `--no-agents-md` writes neither.

## Options

```
pnpm create upwind [directory]

      --skip-install  Write the application, install nothing
      --no-git        Do not make a first commit
      --no-agents-md  Do not write AGENTS.md and CLAUDE.md
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
