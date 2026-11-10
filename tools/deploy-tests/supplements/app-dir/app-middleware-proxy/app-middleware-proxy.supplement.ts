/* eslint-env jest */
// Copied from Next.js (https://github.com/vercel/next.js) under the MIT license:
// Copyright (c) 2025 Vercel, Inc.
//
// From test/e2e/app-dir/app-middleware-proxy/app-middleware-proxy.test.ts
// at 54b876b6b161b0ecda19562eb264bec637e60d6d (v16.4.6).
//
// Run by upwind's deploy tests among what Next.js skips in deploy mode
// (tools/deploy-tests/README.md).
// Upstream registers this case only where the suite is not deployed
// (`if (!isNextDeploy)`); here it is registered as it is under `next start`. Nothing else
// is changed.
import { nextTestSetup } from 'e2e-utils'

describe('app-dir with proxy', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  // TODO: This consistently 404s on Vercel deployments. It technically
  // doesn't repro the bug we're trying to fix but we need to figure out
  // why the handling is different.
  {
    it('should not incorrectly treat a Location header as a rewrite', async () => {
      const res = await next.fetch('/test-location-header')

      // Should get status 200 (not a redirect status)
      expect(res.status).toBe(200)

      // Should get the JSON response associated with the route,
      // and not follow the redirect
      const json = await res.json()
      expect(json).toEqual({ foo: 'bar' })

      // Ensure the provided location is still on the response
      const locationHeader = res.headers.get('location')
      expect(locationHeader).toBe(
        'https://next-data-api-endpoint.vercel.app/api/random'
      )
    })
  }
})
