// Copied from Next.js (https://github.com/vercel/next.js) under the MIT license:
// Copyright (c) 2025 Vercel, Inc.
//
// From test/e2e/app-dir/use-cache-route-handler-only/use-cache-route-handler-only.test.ts
// at 29bbeab09981148ade186e8599ecdede15abc281 (v16.4.3).
//
// Run by upwind's deploy tests among what Next.js skips in deploy mode
// (tools/deploy-tests/README.md).
// Upstream skips the read of the stale value right after the revalidation where the
// suite is deployed (`if (!isNextDeploy)`); here it is made, as it is under `next start`.
// Nothing else is changed.
import { randomUUID } from 'crypto'
import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'

// Explicitly don't mix route handlers with pages in this test app, to make sure
// that this also works in isolation.
describe('use-cache-route-handler-only', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  it('refreshes cached data after tag revalidation', async () => {
    const path = `/tag-revalidation?key=${randomUUID()}`
    const read = () => next.fetch(path).then((response) => response.json())
    const initial = await read()
    expect(initial).toBeDateString()
    expect(await read()).toBe(initial)

    expect((await next.fetch(path, { method: 'POST' })).status).toBe(204)
    // TODO: Restore this assertion on deploy when tag revalidation supports
    // stale-while-revalidate for remote cache entries.
    {
      expect(await read()).toBe(initial)
    }

    await retry(async () => {
      const fresh = await read()
      expect(fresh).toBeDateString()
      expect(new Date(fresh)).toBeAfter(new Date(initial))
    })
  })
})
