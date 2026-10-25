# Native Node fixture

The native-runtime CI packs the public packages, installs a copy of this application, builds it
with `upwind build --target=node`, and moves only `.arkor/node` to a separate directory. It starts
that copy with plain Node and also checks the installed `upwind start` command.

The probes cover App and Pages routing, proxy headers on a page and public file, RSC, a form Server
Action, a traced data file, `child_process`, and sharp's native addon. External rewrites check POST
and PUT uploads, decoded gzip responses, and multiple cookies. A small HTTP control server
holds PPR's dynamic boundary until the shell was received; this checks ordering without a latency
benchmark. Other controlled values exercise ISR and `use cache` invalidation and persistence across
server restarts. An `after()` callback is released during SIGTERM to verify graceful shutdown.
