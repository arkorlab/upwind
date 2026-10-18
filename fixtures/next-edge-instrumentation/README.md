# Instrumentation composition

The matrix builds this application with host instrumentation, then exercises the emitted Edge
middleware, Edge route and Node.js route Functions in workerd. The project's hook value-imports `next/server`
so its early Edge-global initialization cannot hide a missing host hook. Delayed registration,
concurrent first requests, error arguments, hook receivers and failure isolation are checked.
The host imports the fixture package's own `runtime-target` subpath, whose `node` export precedes
`edge-light`, so the emitted code must select the Edge condition explicitly rather than
incidentally finding it first. This self-reference tests package exports without a synthetic
registry dependency.

`next-edge-instrumentation-no-own` copies these same sources and removes `instrumentation.js`
before building, proving that a host hook also works when the project supplied none. No remote
service or credential is used; an attempted network request fails the integration.
