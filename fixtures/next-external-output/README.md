# External output integration

`distDir: '../.next'` places the real Next.js output beside the copied project. Its root page
awaits `connection()` and renders a client component, so an HTTP request must load the bundled
route and its client-reference manifest. `next-matrix` starts the emitted Function in Miniflare
and checks the rendered server and client markers. It does not start `next start` or serve a
prerendered page in place of the Function.
