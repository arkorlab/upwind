# Twoslash runtime compatibility

The route uses the code, compiler options, explicit declaration-file traces, and package versions
of [Next.js 16.4.2's Twoslash fixture](https://github.com/vercel/next.js/tree/2864b1772c37242a9b40ab4d366eb7d368c2a070/test/e2e/twoslash).
The matrix checks its default-mode code and hover annotations against the official expectations.
Diagnostic headers identify a reached handler, a caught error category, and bounded error names
and codes; they do not change its JSON or include exception messages, paths, stacks, or source text.

The dedicated CI job builds with the normal adapter and exercises the emitted Function in local
Miniflare. Every outbound request is refused. It also loads the same emitted runtime and route
entry in a separate diagnostic isolate, then imports the emitted linked Twoslash package in
another fresh isolate. The proof records only hashes, sizes, fixed outcomes, and counts of module
URL and require-helper markers. These probes distinguish route and linked-package initialization
from handler or bridge failures without preloading the Function under test. This is an isolated
compatibility check, with no deployment or delivery-performance claim. A failed annotation or build
fails CI; the baseline is never converted into an expected failure.
