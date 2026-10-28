These are inert source fixtures from Next.js 16.4.3 at commit
`29bbeab09981148ade186e8599ecdede15abc281`, used only for source inspection.

`production.txt` is the committed Node production runtime:
https://github.com/vercel/next.js/blob/29bbeab09981148ade186e8599ecdede15abc281/turbopack/crates/turbopack-tests/tests/snapshot/runtime/default_build_runtime/output/%5Bturbopack%5D_runtime.js

`async-module.txt` is the exact compiled shared async-module section of the
committed development runtime, from `const turbopackQueues` through
`contextPrototype.a = asyncModule`. The fixed Node runtime producer inserts
this same shared source between runtime-utils and base-externals-utils:
https://github.com/vercel/next.js/blob/29bbeab09981148ade186e8599ecdede15abc281/turbopack/crates/turbopack-ecmascript-runtime/src/nodejs_runtime.rs

The fixtures are never evaluated. Next.js is Copyright Vercel, Inc.; these
sources are licensed under the MIT license:
https://github.com/vercel/next.js/blob/29bbeab09981148ade186e8599ecdede15abc281/license.md
