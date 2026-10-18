# Instrumentation composition

The matrix builds this application with host instrumentation, then exercises the emitted Edge
middleware, Edge route and Node.js route Functions in workerd. The project's hook value-imports `next/server`
so its early Edge-global initialization cannot hide a missing host hook. Delayed registration,
concurrent first requests, error arguments, hook receivers and failure isolation are checked.
The host imports the fixture package's own `runtime-target` subpath, whose `node` export precedes
`edge-light`, so the emitted code must select the Edge condition explicitly rather than
incidentally finding it first. This self-reference tests package exports without a synthetic
registry dependency.
Its registration also awaits a separate module through `import()`, proving that a host's lazy
dependency is carried in the emitted Function rather than becoming an unshipped output chunk.

Error-hook composition is asserted for middleware and the Node route. Next.js 16.4.2's Edge
route wrapper calls the handler without dispatching `onRequestError` for a thrown GET, so that
lane explicitly checks the upstream result: HTTP 500 and neither error hook called. It still
requires awaited, once-only host and project registration. The adapter does not add a new error
dispatcher to Next.js.
`next-edge-instrumentation-baseline` compiles the same application with Node-only host options
and independently requires the same Edge route error behavior without Edge composition.

`next-edge-instrumentation-no-own` copies these same sources and removes `instrumentation.js`
before building, proving that a host hook also works when the project supplied none. No remote
service or credential is used; an attempted network request fails the integration.
