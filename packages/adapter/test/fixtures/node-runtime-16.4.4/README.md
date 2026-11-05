These are inert source fixtures from Next.js 16.4.4 at commit
`b175f52b05a5f6c6c39ca72565ea178542be323b`, used only for source inspection.

`production.txt` is the committed Node production runtime:
https://github.com/vercel/next.js/blob/b175f52b05a5f6c6c39ca72565ea178542be323b/turbopack/crates/turbopack-tests/tests/snapshot/runtime/default_build_runtime/output/%5Bturbopack%5D_runtime.js

It differs from 16.4.3's (`../node-runtime/production.txt`) only where Next.js reverted the strict
module factory chunks: it installs no leading strict factory table. The shared async-module section of
the committed development runtime is byte for byte 16.4.3's (`../node-runtime/async-module.txt`).

The fixtures are never evaluated. Next.js is Copyright Vercel, Inc.; these
sources are licensed under the MIT license:
https://github.com/vercel/next.js/blob/b175f52b05a5f6c6c39ca72565ea178542be323b/license.md
