# Native Node.js Functions

The adapter keeps ordinary Functions on Workers. When a retained server load requires a native
Node.js addon, a host that supports bundle versions 11 and 12 can run the complete owning Function
in a Node Container instead. Build tooling merely appearing in an output trace does not select
that backend. Static files, prerendered responses and current cache generations retain their
existing edge delivery paths; only work that needs the Function reaches its compute backend.

Classification requires both a retained load and its owned binary. Direct CommonJS `.node`
loads, default `process.dlopen` calls with a statically known file, and reviewed `bindings` and
`node-gyp-build` loader shapes are recognized. Unknown dynamic loads are refused before publication.
A package name or a `.node` trace alone is insufficient. Unmodified ES-module imports of `.node`
files are refused because Node.js itself does not support them; use the package's Node-compatible
entrypoint. No native exports are fabricated.

Existing precisely guarded Worker-safe JavaScript or WebAssembly fallbacks keep their Worker
backend. A guarded direct native load does not prove such a fallback and is refused. A retained
Node worker with owned native child dependencies is also refused: main-graph binary proof does not
prove the complete child's load closure in this backend's first version. Absolute build-machine
imports, loader environment overrides and ambiguous binary directories are not portable proof.

Routes sharing one built module remain together. Pages Router pages and API routes remain together
because `res.revalidate()` can render another page. Shared middleware, error pages and instrumentation
remain part of their owning Functions. A shared native dependency cannot silently move an explicitly
Edge-runtime route into Node; a layout that cannot retain that contract is refused.
Common Edge middleware can still be part of the Node Function's request pipeline; its standalone
middleware Function and explicitly Edge-runtime route owners remain Workers.

The Node artifact is a content-addressed tar.gz of regular physical files. It preserves Node's
package layout and binary bytes. `upwind/links.json` describes bounded internal aliases for the host
to restore during image preparation; the archive contains no symlink entries. `upwind/native.json`
names only the proved, selected native modules and their hashes. The archive retains other regular
owned trace files without rewriting their selection logic.
The host verifies the artifact,
Node ABI and Linux x64 glibc target before publishing it. Worker loader hooks, process substitutes
and native shims are not applied to Node files. The existing shared cache and request runtime is
retained through a Node transport, rather than replaced with an independent `next start` cache.

The original Next.js manifest consumers and Turbopack runtime are currently verified against
Next.js 16.4.3. Changed compiler or template shapes are refused until their source contracts are
reviewed. This restriction applies to native Node artifacts; ordinary Worker output keeps its
existing version support.

Hook TypeScript is analyzed after compiler lowering and can be bundled as JavaScript. A dependency
executed from its original file must use syntax the target Node runtime can execute directly.
Raw JSX and TypeScript features requiring transformation, such as enums, need compilation first.
Raw TypeScript under an archived `node_modules` directory also requires compilation.

Package import aliases support exact `package.json` mappings to literal relative files or external
packages. Conditional, pattern and chained mappings are refused before publication until their
resolution can be proved without changing the original package metadata.

The first backend supports plain environment values, shared cache access and delegated HTTP
services. Native storage bindings, Durable Objects, Cloudflare Workflows, custom cache-handler
closures and unproved native loaders are refused. The direct CLI and local Miniflare stack also
refuse artifacts they cannot execute. These errors preserve the application's runtime contract.

The dedicated Linux CI control compiles and executes a real N-API binary, creates the actual adapter
artifact, starts its Node HTTP entry, and checks that independent Worker and Edge routes remain on
Workers. A separate CI step verifies a pinned, unchanged Next.js 16.4.3 native fixture, builds it
with the actual adapter and invokes its emitted Node entry on loopback, including `/blog/second`
with `fallback: true`. This checks the artifact and Node transport; hosted cache and deployment
integration still require operator rollout verification. No CI result is implied by this document.
