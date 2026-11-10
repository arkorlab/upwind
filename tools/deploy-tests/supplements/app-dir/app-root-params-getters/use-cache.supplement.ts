// Copied from Next.js (https://github.com/vercel/next.js) under the MIT license:
// Copyright (c) 2025 Vercel, Inc.
//
// From test/e2e/app-dir/app-root-params-getters/use-cache.test.ts
// at 54b876b6b161b0ecda19562eb264bec637e60d6d (v16.4.6).
//
// Run by upwind's deploy tests among what Next.js skips in deploy mode
// (tools/deploy-tests/README.md).
// Upstream skips the read of the stale value right after the revalidation where the
// suite is deployed (`if (!isNextDeploy)`), since its own deployments serve no stale entry
// there; here it is made, as it is under `next start`, which is what this copy asks of a
// deployment. Nothing else is changed.
import { nextTestSetup } from 'e2e-utils'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { retry } from 'next-test-utils'

describe('app-root-param-getters - cache - at runtime', () => {
  const { next } = nextTestSetup({
    files: join(__dirname, 'fixtures', 'use-cache-runtime'),
  })

  async function readSWR(key: string, roots: string) {
    const $ = await next.render$(`/${roots}/swr?key=${key}`)
    expect(`${$('#lang').text()}/${$('#country-code').text()}`).toBe(roots)
    const value = $('#value').text()
    expect(value).toBeDateString()
    return value
  }

  async function revalidateSWR(key: string, roots: string) {
    const response = await next.fetch(`/${roots}/swr/revalidate?key=${key}`, {
      method: 'POST',
    })
    expect(response.status).toBe(204)
  }

  it('should revalidate only the tagged root params', async () => {
    const key = randomUUID()
    const enValue = await readSWR(key, 'en/us')
    const frValue = await readSWR(key, 'fr/ca')
    expect(enValue).not.toBe(frValue)

    await revalidateSWR(key, 'en/us')
    // TODO: Restore this assertion on deploy when tag revalidation supports
    // stale-while-revalidate for remote cache entries.
    {
      expect(await readSWR(key, 'en/us')).toBe(enValue)
    }
    expect(await readSWR(key, 'fr/ca')).toBe(frValue)
    await retry(async () => {
      expect(new Date(await readSWR(key, 'en/us'))).toBeAfter(new Date(enValue))
    })
    expect(await readSWR(key, 'fr/ca')).toBe(frValue)
  })
})
