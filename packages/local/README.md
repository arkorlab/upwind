# @stayingupwind/local

A build served on one machine as it is served deployed. `startStack` runs, under one Miniflare:

- the standalone edge in front;
- the runtime cache's authority and read gateway;
- the prefetch Worker;
- the build's Functions, bound as a deploy binds them.

They run over stores of the stack's own, which go when it is disposed. The build is deployed to the
stack by the same assembly any deploy uses (`deployBundle`, from `@stayingupwind/deploy`), so the
manifest the edge serves by is the one a deployment of that build would have.

`checkStack` asks a stack what every deployment's edge has to answer of it: each prerendered route,
each file of the build and each app Function, as a browser and the router ask for them. It names
every answer that is not what a deployment would give.

The build is the directory `next build` left with the deployment adapter. For the runtime cache,
build with the cache's preset, which bundles the cache's client into the Functions:
`NEXT_ADAPTER_PATH` set to `@stayingupwind/cache`'s `./adapter`. Set `NEXT_DEPLOYMENT_ID` as a
deployment would.

The package runs under Node.js 24.10 or later. Each stack bundles its own Workers with esbuild and
runs them in the workerd that Miniflare installs. The published package is TypeScript sources:
`exports` names `.ts` files, and there is no build step.

## From the command line

```sh
pnpm local:serve --dir <app> [--port <port>] [options]
pnpm local:check --dir <app> [options]
```

- `serve` serves the build until it is interrupted.
- `check` asks the stack once for every prerendered route, every file of the build and every app
  Function, and exits non-zero where an answer is not what a deployment would give.

| Option                                                     | What it does                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `--env-file <file>`                                        | Gives the Functions the variables a `.env` file holds; a later file's value of a name wins         |
| `--kv <name>`, `--r2 <name>`, `--d1 <name>`                | Binds an empty store of that kind under the name given, for an application whose host gives it one |
| `--delivery-policy <id\|file>`                             | Serves under a built-in delivery policy, or the policy a file holds                                |
| `--csp-nonce enforce\|report-only`, `--csp-strict-dynamic` | Has the edge mint a nonce for each document, with `'strict-dynamic'` beside it where asked         |
| `--prover-agent <agent>`                                   | The user agent a check asks as                                                                     |
| `--hostname <host>`                                        | The hostname a check names the site by; the stack is still reached at its own socket               |

Each of `--env-file`, `--kv`, `--r2` and `--d1` may be given more than once.

## From code

| Export                           | What it is                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `startStack`                     | A build served as deployed, until the stack is disposed                                                                  |
| `checkStack`                     | What every deployment's edge has to answer of a stack, and where it does not                                             |
| `deploymentFunctions`            | A build's Functions as Workers, bound as a deploy binds them                                                             |
| `bundleWorker`, `assertHostOnly` | One of the stack's Workers bundled as `wrangler deploy` bundles one, and the check that it holds nothing of a host's own |
| `agentTarget`                    | The deploy target that deploys a build to a stack, through the stack's deploy agent                                      |
