// Copied from Next.js (https://github.com/vercel/next.js) under the MIT license:
// Copyright (c) 2025 Vercel, Inc.
//
// From test/e2e/app-dir/avif-svg-signature-confusion/avif-svg-signature-confusion.test.ts
// at 54b876b6b161b0ecda19562eb264bec637e60d6d (v16.4.6).
//
// Run by upwind's deploy tests among what Next.js skips in deploy mode
// (tools/deploy-tests/README.md).
// Upstream expects Vercel's image CDN where the suite is deployed (`if (isNextDeploy)`): its error
// token for an ordinary SVG, and a 200 for a disguised one. Here both are refused, as under
// `next start`. Nothing else is changed.
import { nextTestSetup } from 'e2e-utils'

describe('avif-svg-signature-confusion', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  it('rejects an ordinary SVG when dangerouslyAllowSVG is false', async () => {
    const res = await next.fetch('/_next/image?url=%2Fcontrol&w=256&q=75', {
      headers: { accept: 'image/webp' },
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('image type is not allowed')
  })

  it('rejects an SVG prefixed with <!--ftypavif-->', async () => {
    const res = await next.fetch('/_next/image?url=%2Fevil&w=256&q=75', {
      headers: { accept: 'image/webp' },
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('image type is not allowed')
  })
})
