# vocabulary

Holds the packages that serve and deploy a deployment — the edge, the runtime cache behind it, the
assembly that deploys a build to them, what the three share, and the stack that runs them on one
machine — to the words any host would use.

Each of those packages is written for whichever host runs it, so none of them may describe one host
in particular: by its name, by the names of its own resources or the parts it is made of, or by
where it keeps its storage. `src/terms.ts` lists each word that is refused and why, with what it
must find and what it must pass over; the check tries those examples before it reads a file.

```bash
pnpm check:vocabulary                  # every mention, by file, line and column
pnpm check:vocabulary --format github  # the same, as annotations on a pull request
```

There is no baseline: a package it reads says none of them. A file is searched whole — comments and
Markdown included, a term of several words found where a soft line break falls inside it, and an
identifier read as the words it is made of (`controlPlane`) — and so is its path, a binary's
included. A term is found in its plural as well, where the plural names the same thing.

What upwind ships under its own name is blanked first, to something that joins no words on either
side of it: the prefixes of its headers, variables, modules and names (`x-arkor-`, `ARKOR_`,
`arkor:`, `arkor-edge`, `arkor-csp`), its `__arkor` marker, its exact `__arkor_edge_bypass` recovery
cookie (`EDGE_BYPASS_COOKIE` in `core/request`), its `.arkor/` directory, the `ppr-shell`
artifact kind, and the copyright line of a package's licence. A prefix is blanked alone, so what
follows it is searched as any name is, and each is blanked only where nothing of a name — a letter
or a digit of any script, `_` or `-` — comes before it. An addition to that list is a change to what
upwind publishes, and is reviewed as one.
