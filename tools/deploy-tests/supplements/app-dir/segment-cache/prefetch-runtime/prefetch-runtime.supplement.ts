// Copied from Next.js (https://github.com/vercel/next.js) under the MIT license:
// Copyright (c) 2025 Vercel, Inc.
//
// From test/e2e/app-dir/segment-cache/prefetch-runtime/prefetch-runtime.test.ts
// at 29bbeab09981148ade186e8599ecdede15abc281 (v16.4.3).
//
// Run by upwind's deploy tests among what Next.js skips in deploy mode
// (tools/deploy-tests/README.md).
// Upstream skips the prefetch of, and the navigation to, a root param that
// generateStaticParams did not name where the suite is deployed (`if (!isNextDeploy)`); here
// they are made, as they are under `next start`. Nothing else is changed: the check of
// `next.cliOutput` after each case stays, as upstream's deployed run keeps it.
import { nextTestSetup } from 'e2e-utils'
import { waitFor } from 'next-test-utils'
import type * as Playwright from 'playwright'
import { createRouterAct } from 'router-act'
import { UNEXPECTED_CACHE_MISS_MESSAGE } from 'next/src/server/use-cache/use-cache-errors'

describe('runtime prefetching', () => {
  const { next, isNextDev } = nextTestSetup({
    files: __dirname,
  })
  if (isNextDev) {
    it('is skipped', () => {})
    return
  }

  let currentCliOutputIndex = 0
  beforeEach(() => {
    resetCliOutput()
  })

  const getCliOutput = () => {
    if (next.cliOutput.length < currentCliOutputIndex) {
      // cliOutput shrank since we started the test, so something (like a `sandbox`) reset the logs
      currentCliOutputIndex = 0
    }
    return next.cliOutput.slice(currentCliOutputIndex)
  }

  const resetCliOutput = () => {
    currentCliOutputIndex = next.cliOutput.length
  }

  // We never expect to see this logged here.
  afterEach(() => {
    if (getCliOutput().includes(UNEXPECTED_CACHE_MISS_MESSAGE)) {
      throw new Error(
        `A test unexpectedly logged "${UNEXPECTED_CACHE_MISS_MESSAGE}"`
      )
    }
  })

  describe.each([
    {
      description: 'in a page',
      prefix: 'in-page',
    },
    {
      description: 'in a private cache',
      prefix: 'in-private-cache',
    },
    {
      description: 'passed to a public cache',
      prefix: 'passed-to-public-cache',
    },
  ])('$description', ({ prefix }) => {
    it('includes root params, but not dynamic content', async () => {
      let page: Playwright.Page
      const browser = await next.browser('/with-root-param/en', {
        beforePageLoad(p: Playwright.Page) {
          page = p
        },
      })
      const act = createRouterAct(page, { includeAppShellRequests: true })

      // Reveal the link to trigger a runtime prefetch for one value of the root param
      await act(async () => {
        const linkToggle = await browser.elementByCss(
          `input[data-link-accordion="/with-root-param/en/${prefix}/root-params"]`
        )
        await linkToggle.click()
      }, [
        // Should allow reading root params
        // Shell
        {
          includes: 'Lang: en',
          kind: 'runtime',
        },
        // Prefetch
        {
          includes: 'Lang (in prefetch): en',
          kind: 'runtime',
        },
        // Should not prefetch the dynamic content
        {
          includes: 'Dynamic content',
          block: 'reject',
        },
      ])

      // TODO(runtime-ppr) - visiting root params that weren't in generateStaticParams errors when deployed
      {
        // Reveal the link to trigger a runtime prefetch for a different value of the root param
        await act(async () => {
          const linkToggle = await browser.elementByCss(
            `input[data-link-accordion="/with-root-param/de/${prefix}/root-params"]`
          )
          await linkToggle.click()
        }, [
          // Should allow reading root params
          // Shell
          {
            includes: 'Lang: de',
            kind: 'runtime',
          },
          // Prefetch
          {
            includes: 'Lang (in prefetch): de',
            kind: 'runtime',
          },
          // Should not prefetch the dynamic content
          {
            includes: 'Dynamic content',
            block: 'reject',
          },
        ])
      }

      // Navigate to the first page
      await act(async () => {
        await act(
          async () => {
            await browser
              .elementByCss(
                `a[href="/with-root-param/en/${prefix}/root-params"]`
              )
              .click()
          },
          {
            // Temporarily block the navigation request.
            // The runtime-prefetched parts of the tree should be visible before it finishes.
            includes: 'Dynamic content',
            block: true,
          }
        )
        expect(await browser.elementById('root-param-value').text()).toEqual(
          'Lang: en'
        )
      })
      // After navigating, we should see both the parts that we prefetched and dynamic content.
      expect(await browser.elementById('root-param-value').text()).toEqual(
        'Lang: en'
      )
      expect(await browser.elementById('dynamic-content').text()).toEqual(
        'Dynamic content'
      )

      // TODO(runtime-ppr) - visiting root params that weren't in generateStaticParams errors when deployed
      {
        await browser.back()

        // Navigate to the other page
        await act(async () => {
          await act(
            async () => {
              await browser
                .elementByCss(
                  `a[href="/with-root-param/de/${prefix}/root-params"]`
                )
                .click()
            },
            {
              // Temporarily block the navigation request.
              // The runtime-prefetched parts of the tree should be visible before it finishes.
              includes: 'Dynamic content',
              block: true,
            }
          )
          expect(await browser.elementById('root-param-value').text()).toEqual(
            'Lang: de'
          )
        })
        // After navigating, we should see both the parts that we prefetched and dynamic content.
        expect(await browser.elementById('root-param-value').text()).toEqual(
          'Lang: de'
        )
        expect(await browser.elementById('dynamic-content').text()).toEqual(
          'Dynamic content'
        )
      }
    })
  })
})
