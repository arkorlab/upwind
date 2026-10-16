/**
 * The destinations Fetch calls script-like. A module preload of one is fetched as a script, and a
 * policy that governs scripts governs it.
 */
const SCRIPT_LIKE_DESTINATIONS: readonly string[] = [
  'audioworklet',
  'paintworklet',
  'script',
  'serviceworker',
  'sharedworker',
  'worker',
];

/**
 * The links a browser fetches a script for, which `script-src` governs as it does a `<script>`.
 *
 * The edge gives them the nonce it mints as it gives one to every script, and whatever stamps a shell
 * the way the edge does reads the same list — one list, so the two cannot drift apart. React gives
 * the bootstrap script's preload the nonce it renders with; a nonce the edge mints in its place
 * finds the link without one, and a policy that allows the script by its nonce alone — as one
 * with `'strict-dynamic'` does, `'self'` and hosts no longer counting — refuses the preload and
 * reports it on every page view.
 *
 * A module preload is a script where its `as` is: one with none is read as `"script"`, and the
 * script-like destinations are scripts. So is one whose `as` is empty, `as` or `as=""`: the empty
 * string is no destination, now or ever, and an `as` that names none is read as missing. It may
 * name `json`, `style` or `text` as well, which are not, so those — and anything the HTML Standard
 * adds beside them — are left as they came, with every other link: a nonce is never put where it
 * would trust what no script directive meant to.
 */
export const SCRIPT_PRELOAD_LINKS: readonly string[] = [
  'link[rel~="preload" i][as="script" i]',
  'link[rel~="modulepreload" i]:not([as])',
  'link[rel~="modulepreload" i][as=""]',
  ...SCRIPT_LIKE_DESTINATIONS.map(
    (destination) => `link[rel~="modulepreload" i][as="${destination}" i]`,
  ),
];
