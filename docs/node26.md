# Node.js 26 development toolchain

Development and ordinary CI select Node.js 26.13.0 (Lithium LTS). Public package engines and
generated applications retain Node.js 24 support and the Node.js 24 type definitions. The build
integration and native Function CI lanes run under both 24.22.1 and 26.13.0.

Corepack is installed separately on Node.js 26. Type stripping is built in, but the removed
`--experimental-transform-types` option is supplied only when the runtime supports it.

The fixed JWT, WebSocket and Next require-hook records name the exact producer Node version.
Runtime initialization rejects a different version; unknown versions cannot select these profiles.
The existing source hashes, loader ownership, optional dependency absence and realm checks remain
mandatory. The version is selected before application evaluation, with no request-time I/O.

Node 26 removed `buffer.SlowBuffer`, which the original fixed JWT dependency still reads.
Trusted initialization installs a compatibility constructor before capturing the builtin realm.
It delegates to `Buffer.allocUnsafeSlow`, with the constructor/prototype chains from Node 24's
[official buffer implementation](https://github.com/nodejs/node/blob/v24.22.1/lib/buffer.js).
An existing export is refused; subsequent constructor, prototype and descriptor changes remain
covered by the same realm checks. The original JWT source and its hash stay intact.

The reviewed official [26.13.0 CommonJS loader](https://github.com/nodejs/node/blob/v26.13.0/lib/internal/modules/cjs/loader.js)
still calls `module._compile(source, filename, loadedFormat)` for JavaScript source. The
[ESM translator](https://github.com/nodejs/node/blob/v26.13.0/lib/internal/modules/esm/translators.js)
uses the CommonJS loader for the default synchronous path; the alternate asynchronous hook path
is outside the approved startup contract. Node 26 lazily loads its TypeScript stripper, without
changing that JavaScript evaluation boundary. The dedicated CI lanes exercise real initialization
and rejection after source, loader, realm and cache mutation on both reviewed releases.

The independent Pages compiler corpus keeps its original Node 24 producer and immutable input
pins. Its output is historical qualification data, not a declaration of the current toolchain.

The real-Next native addon CI verifies the original fixture blobs before copying them. On Node 26,
the copy's single `context->GetIsolate()` call uses `v8::Isolate::GetCurrent()` instead: V8 removed
the Context method. Both Git blob identities and the exact substitution are logged, and build
results name `node26-current-isolate-v1`. The Node 24 copy and the checked-out upstream inputs
remain unchanged; this compatibility edit is never applied to application sources.
