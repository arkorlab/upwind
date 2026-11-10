// Copied from Next.js (https://github.com/vercel/next.js) under the MIT license:
// Copyright (c) 2025 Vercel, Inc.
//
// From test/e2e/app-dir/segment-cache/prefetch-static-shell/prefetch-static-shell.test.ts
// at 54b876b6b161b0ecda19562eb264bec637e60d6d (v16.4.6).
//
// Run by upwind's deploy tests among what Next.js skips in deploy mode
// (tools/deploy-tests/README.md).
// Upstream accepts an ISR fallback for this prefetch and waits for the retries where the
// suite is deployed (`if (isNextDeploy)`); here the first static prefetch must hold the
// page, as it must under `next start`, since the route asks for a blocking prerender.
// Nothing else is changed.
import { nextTestSetup } from 'e2e-utils'
import type * as Playwright from 'playwright'
import { createRouterAct } from 'router-act'
import { retry } from '../../../../lib/next-test-utils'

// @force-gate prefetching
describe('static App Shell prefetch attempt', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  describe('ensureStatic', () => {
    describe('ensureStatic = "navigation"', () => {
      // NOTE: "navigation" can't use IO, so we use params instead.

      it('uses a static request for a `prefetch={true}` link to a page that uses static params and was not prerendered', async () => {
        let page: Playwright.Page
        const browser = await next.browser('/', {
          beforePageLoad(p: Playwright.Page) {
            page = p
          },
        })
        const act = createRouterAct(page, { includeAppShellRequests: true })

        const slug = 'not-prerendered-1'
        const href = `/ensure-static/navigation/${slug}`

        // Reveal a prefetch-true link to the page.
        // The page has `ensureStatic = "navigation"`, and uses params.
        // This param was not prerendered at build, but we should not serve an ISR fallback,
        // because `ensureStatic = "navigation"` requires prerenders to be blocking.
        // It should use a static prefetch.
        {
          await act(async () => {
            await browser
              .elementByCss(
                `input[data-prefetch="true"][data-link-accordion="${href}"]`
              )
              .click()
          }, [
            // Static prefetch
            {
              includes: `Slug: ${slug}`,
              kind: 'static',
            },
            // No runtime requests (e.g. runtime follow-up due to ISR fallback)
            { includes: '', kind: 'runtime', block: 'reject' },
          ])
        }

        // The prefetch is complete, because the page is required to be fully-static.
        await act(
          () => browser.elementByCss(`a[href="${href}"]`).click(),
          'no-requests'
        )
        expect(await browser.elementById('slug').text()).toBe(`Slug: ${slug}`)
      })
    })
  })
})
