// Copied from Next.js (https://github.com/vercel/next.js) under the MIT license:
// Copyright (c) 2025 Vercel, Inc.
//
// From test/e2e/app-dir/partial-fallback-shell-upgrade/partial-fallback-shell-upgrade.test.ts
// at 54b876b6b161b0ecda19562eb264bec637e60d6d (v16.4.6).
//
// Run by upwind's deploy tests among what Next.js skips in deploy mode
// (tools/deploy-tests/README.md).
// Upstream waits for `x-vercel-cache: HIT` where the suite is deployed (`if (isNextDeploy)`), which
// only Vercel answers, and runs the suite on adapters alone. A deployment may publish a shell
// behind its answer, so the waits stay; here they wait for the
// page's own `data-rendered-at`, which is what the cases go on to ask of it. Nothing else is changed.
import cheerio from 'cheerio'
import { nextTestSetup } from 'e2e-utils'
import { splitResponseWithPPRSentinel } from 'e2e-utils/ppr'
import { retry } from 'next-test-utils'
import path from 'path'

type NextInstance = ReturnType<typeof nextTestSetup>['next']

function createSplitHTMLFetcher(next: NextInstance) {
  return async function fetchSplitHTML(pathname: string) {
    const response = await next.fetch(pathname)
    expect(response.status).toBe(200)

    const [staticPart, dynamicPart] = await splitResponseWithPPRSentinel(
      async () => {
        if (!response.body) {
          throw new Error(`Expected a streamed response body for ${pathname}`)
        }

        return response.body
      }
    )

    return {
      response,
      dynamicPart,
      static$: cheerio.load(staticPart),
    }
  }
}

describe('partial-fallback-shell-upgrade - partialPrefetching disabled', () => {
  const { next, isNextDev } = nextTestSetup({
    files: path.join(__dirname, 'fixtures', 'partial-prefetching-disabled'),
  })

  if (isNextDev) {
    it('skipped in dev', () => {})
    return
  }

  const fetchSplitHTML = createSplitHTMLFetcher(next)

  it('shares an on-demand shell across params without generateStaticParams', async () => {
    const firstResult = await fetchSplitHTML('/blocking/c/foo')
    const renderedAt = firstResult.static$('#one').attr('data-rendered-at')

    expect(firstResult.static$('#one').text()).toBe('c')
    expect(renderedAt).toMatch(/^\d+(?:\.\d+)?$/)
    expect(firstResult.static$('#two').length).toBe(0)
    expect(firstResult.static$('#two-fallback').text()).toBe('loading two...')
    expect(firstResult.dynamicPart).toContain('<div id="two">foo</div>')

    await retry(async () => {
      const cachedResult = await fetchSplitHTML('/blocking/c/foo')
      expect(cachedResult.static$('#one').attr('data-rendered-at')).toBe(
        renderedAt
      )
    })

    const secondResult = await fetchSplitHTML('/blocking/c/bar')

    expect(secondResult.static$('#one').text()).toBe('c')
    expect(secondResult.static$('#one').attr('data-rendered-at')).toBe(
      renderedAt
    )
    expect(secondResult.static$('#two').length).toBe(0)
    expect(secondResult.static$('#two-fallback').text()).toBe('loading two...')
    expect(secondResult.dynamicPart).toContain('<div id="two">bar</div>')
    expect(secondResult.dynamicPart).not.toContain('<div id="two">foo</div>')
  })

  it('keeps params without generateStaticParams dynamic after explicit revalidation of an on-demand shell', async () => {
    const pathname = '/blocking/d/foo'
    const firstResult = await fetchSplitHTML(pathname)
    const firstRenderedAt = firstResult.static$('#one').attr('data-rendered-at')
    expect(firstRenderedAt).toMatch(/^\d+(?:\.\d+)?$/)

    await retry(async () => {
      const cachedResult = await fetchSplitHTML(pathname)
      expect(cachedResult.static$('#one').attr('data-rendered-at')).toBe(
        firstRenderedAt
      )
    })

    const revalidateResponse = await next.fetch(
      `/api/revalidate?path=${encodeURIComponent(pathname)}`
    )
    expect(revalidateResponse.status).toBe(200)
    expect(await revalidateResponse.json()).toEqual({ revalidated: true })

    await retry(async () => {
      const revalidatedResult = await fetchSplitHTML(pathname)
      const revalidatedAt = revalidatedResult
        .static$('#one')
        .attr('data-rendered-at')

      expect(revalidatedResult.static$('#one').text()).toBe('d')
      expect(revalidatedAt).toMatch(/^\d+(?:\.\d+)?$/)
      expect(revalidatedAt).not.toBe(firstRenderedAt)
      expect(revalidatedResult.static$('#two').length).toBe(0)
      expect(revalidatedResult.static$('#two-fallback').text()).toBe(
        'loading two...'
      )
      expect(revalidatedResult.dynamicPart).toContain('<div id="two">foo</div>')

      const secondResult = await fetchSplitHTML('/blocking/d/bar')

      expect(secondResult.static$('#one').text()).toBe('d')
      expect(secondResult.static$('#one').attr('data-rendered-at')).toBe(
        revalidatedAt
      )
      expect(secondResult.static$('#two').length).toBe(0)
      expect(secondResult.static$('#two-fallback').text()).toBe(
        'loading two...'
      )
      expect(secondResult.dynamicPart).toContain('<div id="two">bar</div>')
      expect(secondResult.dynamicPart).not.toContain('<div id="two">foo</div>')
    })
  })

  it('reuses generated optional catch-all pages before and after explicit revalidation', async () => {
    for (const [pathname, parts] of [
      ['/optional/named', 'named'],
      ['/optional', ''],
    ]) {
      const first$ = await next.render$(pathname)
      const firstRenderedAt = first$('#optional').attr('data-rendered-at')

      expect(first$('#optional').text()).toBe(parts)
      expect(firstRenderedAt).toMatch(/^\d+(?:\.\d+)?$/)

      const repeated$ = await next.render$(pathname)

      expect(repeated$('#optional').text()).toBe(parts)
      expect({
        pathname,
        renderedAt: repeated$('#optional').attr('data-rendered-at'),
      }).toEqual({ pathname, renderedAt: firstRenderedAt })

      await retry(async () => {
        const cachedResponse = await next.fetch(pathname)
        expect(cachedResponse.status).toBe(200)
        const cached$ = cheerio.load(await cachedResponse.text())
        expect(cached$('#optional').attr('data-rendered-at')).toBe(
          firstRenderedAt
        )
      })

      const revalidateResponse = await next.fetch(
        `/api/revalidate?path=${encodeURIComponent(pathname)}`
      )
      expect(revalidateResponse.status).toBe(200)
      expect(await revalidateResponse.json()).toEqual({ revalidated: true })

      await retry(async () => {
        const revalidated$ = await next.render$(pathname)
        const revalidatedRenderedAt =
          revalidated$('#optional').attr('data-rendered-at')

        expect(revalidated$('#optional').text()).toBe(parts)
        expect(revalidatedRenderedAt).toMatch(/^\d+(?:\.\d+)?$/)
        expect(revalidatedRenderedAt).not.toBe(firstRenderedAt)

        const cached$ = await next.render$(pathname)

        expect(cached$('#optional').text()).toBe(parts)
        expect({
          pathname,
          renderedAt: cached$('#optional').attr('data-rendered-at'),
        }).toEqual({ pathname, renderedAt: revalidatedRenderedAt })
      })
    }
  })
})
