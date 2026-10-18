# External output integration

The matrix installs the copied project in a temporary npm workspace. `distDir: '../.next'` places
the real Next.js output beside it, with dependencies visible to both the application and output.
The root page awaits `connection()` and renders a client component, so an HTTP request must load
the bundled route and its client-reference manifest. `next-matrix` starts the emitted Function in Miniflare
and checks the rendered server and client markers. It does not start `next start` or serve a
prerendered page in place of the Function.

A Pages API route is requested in the same Function. Next.js keeps that route's `routeModule`
private, so checking its HTTP status and body also covers output paths the generated entry cannot
normalize through a public export.
