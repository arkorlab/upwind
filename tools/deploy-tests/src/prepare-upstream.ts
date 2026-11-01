import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SHARED_FORM_TEST = 'test/e2e/next-form/default/shared-tests.util.ts';
const BROWSER = `        const session = await next.browser(pathPrefix + '/forms/basic')`;
const SUBMIT = `        const submitButton = await session.elementByCss('[type="submit"]')
        await submitButton.click()`;
const LOADING = `        if (isAppDir) {
          // we should have prefetched a loading state, so it should be displayed
          await session.waitForElementByCss('#loading')
        }`;
const TITLE = `'should soft-navigate on submit' +
        (isAppDir ? ' and show the prefetched loading state' : '')`;

const PREFETCH_BROWSER = `        let searchPrefetch = Promise.resolve()
        const session = await next.browser(pathPrefix + '/forms/basic', {
          beforePageLoad(page) {
            if (!isAppDir || isNextDev) return
            searchPrefetch = page.waitForResponse((response) =>
              new URL(response.url()).pathname === '/search' &&
              response.request().headers()['next-router-prefetch'] === '1'
            ).then(async (response) => {
              expect(response.ok()).toBe(true)
              expect(await response.finished()).toBeNull()
            })
            // Navigation can fail before the test awaits this promise.
            void searchPrefetch.catch(() => {})
          },
        })`;
const PREFETCH_SUBMIT = `        const submitButton = await session.elementByCss('[type="submit"]')
        if (isAppDir && !isNextDev) {
          await searchPrefetch
          await session.waitForIdleNetwork()
        }
        await submitButton.click()`;

/**
 * The shared Form test asserts a prefetched loading state without waiting for its prefetch. Observe
 * that response before navigation, then use the dedicated upstream Form test's idle-network barrier.
 * Every original assertion remains. An unfamiliar source layout needs review instead of a silent edit.
 */
export function prepareFormPrefetch(source: string): string {
  const start = source.indexOf(TITLE);
  const end = source.indexOf("    it('should soft-navigate to the formAction", start);
  if (start === -1 || end === -1) {
    throw new Error('unrecognized upstream Form test');
  }
  const test = source.slice(start, end);
  if (
    test.split(BROWSER).length !== 2 ||
    test.split(SUBMIT).length !== 2 ||
    !test.includes(LOADING)
  ) {
    throw new Error('unrecognized upstream Form prefetch setup');
  }
  const prepared = test
    .replace(BROWSER, () => PREFETCH_BROWSER)
    .replace(SUBMIT, () => PREFETCH_SUBMIT);
  return source.slice(0, start) + prepared + source.slice(end);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  const [nextDir, ...extra] = process.argv.slice(2);
  if (nextDir === undefined || extra.length > 0) {
    throw new Error('usage: node prepare-upstream.ts <nextjs-checkout>');
  }
  const file = path.resolve(nextDir, SHARED_FORM_TEST);

  const source = readFileSync(file, 'utf8');
  const prepared = prepareFormPrefetch(source);

  writeFileSync(file, prepared);
}
