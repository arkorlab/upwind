# Durable Object fixture

`counter.ts` exercises native SQLite storage and RPC. `pnpm check:durable-objects` bundles it as a
separate owner Worker, validates source paths and exports, and publishes its namespace through the
same local-resource and SDK path an application uses. It checks that startup does not construct an
object, calls both `fetch` and RPC, then starts a second process to prove persisted data survives.
No Next.js build, Cloudflare credentials or remote resource is required.
