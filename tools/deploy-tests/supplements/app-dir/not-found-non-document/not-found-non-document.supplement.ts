// Copied from Next.js (https://github.com/vercel/next.js) under the MIT license:
// Copyright (c) 2025 Vercel, Inc.
//
// From test/e2e/app-dir/not-found-non-document/not-found-non-document.test.ts
// at 29bbeab09981148ade186e8599ecdede15abc281 (v16.4.3).
//
// Run by upwind's deploy tests among what Next.js skips in deploy mode
// (tools/deploy-tests/README.md).
// Upstream expects an HTML 404 from these cases where the suite is deployed
// (`if (isNextDeploy)`); here they expect what `next start` answers. The one check of
// `next.cliOutput` is left out: a deployment's output holds its build, not what it served.
// Nothing else is changed.
import { nextTestSetup } from 'e2e-utils'

describe('not-found-non-document', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  it('returns a plain text 404 for subresource requests to unknown paths', async () => {
    const res = await next.fetch('/web-app-manifest-192x192.png', {
      headers: {
        accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8',
        'sec-fetch-dest': 'image',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-site': 'same-origin',
      },
    })
    expect(res.status).toBe(404)
    {
      expect(res.headers.get('content-type')).toContain('text/plain')
      expect(res.headers.get('cache-control')).toBe(
        'private, no-cache, no-store, max-age=0, must-revalidate'
      )
      expect(await res.text()).toBe('Not Found')
    }
  })

  it('returns a plain text 404 for font and manifest requests to unknown paths', async () => {
    for (const dest of ['font', 'manifest']) {
      const res = await next.fetch(`/missing-${dest}`, {
        headers: {
          'sec-fetch-dest': dest,
          'sec-fetch-mode': 'no-cors',
          'sec-fetch-site': 'same-origin',
        },
      })
      expect(res.status).toBe(404)
      {
        expect(res.headers.get('content-type')).toContain('text/plain')
        expect(res.headers.get('cache-control')).toBe(
          'private, no-cache, no-store, max-age=0, must-revalidate'
        )
        expect(await res.text()).toBe('Not Found')
      }
    }
  })
})
