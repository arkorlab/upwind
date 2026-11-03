// Copied from Next.js (https://github.com/vercel/next.js) under the MIT license:
// Copyright (c) 2025 Vercel, Inc.
//
// From test/e2e/app-dir/segment-cache/cached-navigations/cached-navigations.test.ts
// at b175f52b05a5f6c6c39ca72565ea178542be323b (v16.4.4).
//
// Run by upwind's deploy tests among what Next.js skips in deploy mode
// (tools/deploy-tests/README.md).
// Upstream returns early from these cases where the suite is deployed, once the route
// answers 500 (`if (isNextDeploy)`); here they run on, as they do under `next start`.
// Nothing else is changed.
import cheerio from 'cheerio'
import path from 'path'
import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'
import type * as Playwright from 'playwright'
import { createRouterAct } from 'router-act'

describe('cached navigations', () => {
  const { next, isNextDev } = nextTestSetup({
    files: path.join(__dirname, 'default'),
  })

  if (isNextDev) {
    it('is skipped', () => {})
    return
  }

  it('does not cache synchronous IO after a novel param resolves', async () => {
    const route = '/fully-static-params/time'
    const hub = '/fallback-params-hub/time/a'
    let page: Playwright.Page
    const browser = await next.browser('/fallback-params-hub/time/start', {
      async beforePageLoad(browserPage: Playwright.Page) {
        page = browserPage
        await page.clock.install()
      },
    })
    const act = createRouterAct(page)

    await act(
      async () => {
        await browser
          .elementByCss(`input[data-link-accordion="${route}"]`)
          .click()
        await browser.elementByCss(`a[href="${route}"]`).click()
      },
      { includes: 'Top:' }
    )
    const timestamp = await browser.elementById('timestamp').text()
    expect(timestamp).not.toBe('')

    await act(
      async () => {
        await browser
          .elementByCss(`input[data-link-accordion="${hub}"]`)
          .click()
        await browser.elementByCss(`a[href="${hub}"]`).click()
      },
      { includes: 'Fallback params hub a' }
    )
    await page.clock.fastForward(60_000)

    await act(async () => {
      await act(
        async () => {
          await browser
            .elementByCss(`input[data-link-accordion="${route}"]`)
            .click()
          await browser.elementByCss(`a[href="${route}"]`).click()
        },
        { includes: 'Top:', block: true }
      )

      expect(await browser.elementByCss('main').text()).not.toContain(
        'Top: time'
      )
    })
    expect(await browser.elementById('timestamp').text()).not.toBe(timestamp)
  })

  it('finishes a full prefetch after synchronous IO interrupts its shell', async () => {
    const route = '/fully-static-params/time'

    let page: Playwright.Page
    const browser = await next.browser('/fallback-params-hub/time/start', {
      beforePageLoad(browserPage: Playwright.Page) {
        page = browserPage
      },
    })
    const act = createRouterAct(page)
    await act(
      async () => {
        await browser
          .elementByCss(`input[data-link-accordion="${route}"]`)
          .click()
        await browser.elementByCss(`a[href="${route}"]`).click()
      },
      { includes: 'Top:' }
    )
    const timestamp = await browser.elementById('timestamp').text()

    const hub = '/fallback-params-hub/time/a'
    await act(
      async () => {
        await browser
          .elementByCss(`input[data-link-accordion="${hub}"]`)
          .click()
        await browser.elementByCss(`a[href="${hub}"]`).click()
      },
      { includes: 'Fallback params hub a' }
    )
    await act(
      async () => {
        await browser.eval('window.next.router.refresh()')
      },
      { includes: 'Fallback params hub a' }
    )

    // Refresh clears segment data and BFCache but retains the route tree. The
    // full prefetch must fetch new data without a cold static tree prerender.
    const fullPrefetchLink = `${route}#full-prefetch`
    await act(
      async () => {
        await browser
          .elementByCss(`input[data-link-accordion="${fullPrefetchLink}"]`)
          .click()
      },
      { includes: 'Top:' }
    )

    await act(async () => {
      await browser.elementByCss(`a[href="${fullPrefetchLink}"]`).click()
    }, 'no-requests')
    expect(await browser.elementById('top').text()).toBe('Top: time')
    expect(await browser.elementById('timestamp').text()).not.toBe(timestamp)
  })
})
