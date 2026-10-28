/**
 * The values of `as` a module preload is fetched as no script under: those it is fetched as
 * something else under (`json`, `style`, `text`), and the other keywords of the attribute, the
 * preload destinations a module preload is not fetched under at all (HTML Standard, `as`).
 */
const NOT_SCRIPT_MODULE_PRELOADS: readonly string[] = [
  'json',
  'style',
  'text',
  'fetch',
  'font',
  'image',
  'track',
];

/** What leaves a module preload under `NOT_SCRIPT_MODULE_PRELOADS` out of a selector. */
function notScriptModulePreload(): string {
  return NOT_SCRIPT_MODULE_PRELOADS.map((as) => `:not([as="${as}" i])`).join('');
}

/**
 * The links a browser fetches a script for, which `script-src` governs as it does a `<script>`.
 *
 * The edge gives a shell's the nonce it mints as it gives one to every script of the shell, and
 * whatever stamps a shell the way the edge does reads the same list — one list, so the two cannot
 * drift apart. React gives the bootstrap script's preload the nonce it renders with, and a shell is
 * rendered with none, there being no request then to read one off: left as it was, the link would
 * carry none, and a policy that allows the script by its nonce alone — as one with
 * `'strict-dynamic'` does, `'self'` and hosts no longer counting — refuses the preload and reports
 * it on every page view.
 *
 * A module preload is a script unless its `as` names one of `NOT_SCRIPT_MODULE_PRELOADS`. The
 * attribute has no default: a missing value, an empty one (`as`, `as=""`) and one that names none
 * of its keywords (`as="bogus"`, `as=" script "`) are read alike, as `"script"`, and the script-like
 * destinations are scripts too. Those named are left as they came, with every other link: a nonce
 * is never put where it would trust what no script directive meant to. A keyword the HTML Standard
 * adds is stamped until it joins them, as a browser that predates it fetches it: as a script.
 */
export const SCRIPT_PRELOAD_LINKS: readonly string[] = [
  'link[rel~="preload" i][as="script" i]',
  `link[rel~="modulepreload" i]${notScriptModulePreload()}`,
];
