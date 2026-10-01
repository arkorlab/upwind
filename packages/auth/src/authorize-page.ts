/**
 * The page upwind shows where a provider's consent screen would be.
 *
 * It exists to be obvious. A stand-in that signed you in silently would look exactly like a working
 * integration, and the first time anybody found out otherwise would be in production — so this says
 * whose screen it is, which provider it is standing in for, and what makes it stop appearing. The
 * one control on it is the identity to sign in as, because the thing a real provider gives you that
 * a hard-coded user does not is a second account to test with.
 *
 * No framework, no assets, no network: one document, styled inline, that works before the
 * application has rendered anything of its own and works with the dev server's bundler still busy.
 *
 * Two things in the stylesheet are load-bearing rather than taste. `box-sizing: border-box` on the
 * card and the field, because without it their padding and border are added to the hundred per cent
 * and the page runs off the side of a narrow window — which is the width a second browser window
 * tends to be. And `color-scheme: light dark`, so the form controls are drawn in the scheme the rest
 * of the page is.
 *
 * Nothing interpolated below may contain a backtick: this is a template literal, and one would end
 * it. Explanations go here, where they also do not ship to a browser.
 */

/** What the page needs to know; everything else it decides. */
export interface AuthorizePage {
  /** The provider being stood in for, as the project named it. */
  readonly provider: string;
  /** Its display name, which for a provider the project declared is the real provider's. */
  readonly name: string;
  /** Better Auth's own state parameter, echoed back untouched or the flow is refused. */
  readonly state: string;
  /** The identity the field starts on, so the common case is one click. */
  readonly suggested: string;
}

/**
 * Text as an attribute value or as content.
 *
 * Everything interpolated below is either this application's own configuration or a parameter
 * Better Auth generated, so none of it is an attacker's today. It is escaped because "today" is
 * doing too much work in that sentence: the state is a value that arrives on the query string, and
 * a page that reflects a query string unescaped is the same bug whoever set the value.
 */
function escaped(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function authorizePage(page: AuthorizePage): string {
  const provider = escaped(page.name);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · upwind</title>
<style>
  :root { color-scheme: light dark; --edge: #d4d4d4; --dim: #6b6b6b; }
  @media (prefers-color-scheme: dark) { :root { --edge: #333; --dim: #9a9a9a; } }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem;
    font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  main {
    width: 100%; max-width: 26rem; box-sizing: border-box;
    border: 1px solid var(--edge); padding: 1.75rem;
  }
  h1 { font-size: 1.0625rem; font-weight: 600; margin: 0 0 0.25rem; }
  p { margin: 0 0 1.25rem; color: var(--dim); font-size: 0.875rem; }
  label { display: block; font-size: 0.8125rem; font-weight: 500; margin-bottom: 0.375rem; }
  input {
    width: 100%; box-sizing: border-box; padding: 0.5rem 0.625rem; font: inherit;
    border: 1px solid var(--edge); background: transparent; color: inherit;
  }
  button {
    width: 100%; margin-top: 1rem; padding: 0.5rem; font: inherit; font-weight: 500;
    border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer;
  }
  button:hover { opacity: 0.7; }
  footer { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--edge); }
  footer p { margin: 0; font-size: 0.8125rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125em; }
</style>
</head>
<body>
<main>
  <h1>upwind is standing in for ${provider}</h1>
  <p>This is not ${provider}. Nothing here reaches it, and no account of yours is involved.</p>
  <form method="get">
    <input type="hidden" name="provider" value="${escaped(page.provider)}">
    <input type="hidden" name="state" value="${escaped(page.state)}">
    <label for="email">Sign in as</label>
    <input id="email" name="email" type="email" required autofocus
           value="${escaped(page.suggested)}" autocomplete="off" spellcheck="false">
    <button type="submit">Continue</button>
  </form>
  <footer>
    <p>
      You are seeing this because this project has no OAuth credentials and no
      <code>AUTH_SECRET</code>. Set them and ${provider} answers instead — there is nothing to
      switch off, and this page cannot appear in a production build.
    </p>
  </footer>
</main>
</body>
</html>
`;
}
