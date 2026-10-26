import { describe, expect, it } from 'vitest';

import { buildRecoveryHtml, recoveryScriptCspSource } from '../../host/src/splice/recovery.ts';
import {
  acceptsCspNonce,
  allowInlineScriptHash,
  allowRecoveryScript,
  applyCspNonce,
  hasCspNoncePlaceholder,
  permitsAnyInlineScript,
  sandboxBlocksRecovery,
  withCspNoncePlaceholder,
  withoutCspNonces,
} from '../src/request/csp.ts';

const HASH = "'sha256-abc='";

describe('allowInlineScriptHash', () => {
  it('does not activate a source separated by non-ASCII whitespace', () => {
    for (const space of ['\u{A0}', '\u{2003}', '\u{FEFF}']) {
      expect(allowInlineScriptHash(`default-src 'none'; script-src ${space}*`, HASH)).toBe(
        `default-src 'none'; script-src 'none' ${HASH}`,
      );
    }
  });

  it('honors the first directive and only ASCII whitespace', () => {
    expect(allowInlineScriptHash("script-src\t'self'; SCRIPT-SRC *", HASH)).toBe(
      `script-src 'self' ${HASH}`,
    );
    expect(allowInlineScriptHash("default-src 'none'; \vscript-src *", HASH)).toBe(
      `default-src 'none'; script-src 'none' ${HASH}`,
    );
    expect(allowInlineScriptHash('script-src \v*', HASH)).toBe(`script-src \v* ${HASH}`);
  });

  it('leaves a policy that already allows inline scripts alone', () => {
    const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'";

    expect(allowInlineScriptHash(csp, HASH)).toBe(csp);
  });

  it('adds the hash when script-src restricts inline scripts', () => {
    expect(allowInlineScriptHash("script-src 'self'; img-src *", HASH)).toBe(
      `script-src 'self' ${HASH}; img-src *`,
    );
  });

  it('adds the hash when unsafe-inline is already neutralised by another hash', () => {
    // CSP level 3 ignores `unsafe-inline` as soon as a hash or nonce is present.
    const csp = "script-src 'unsafe-inline' 'sha256-other='";

    expect(allowInlineScriptHash(csp, HASH)).toBe(`${csp} ${HASH}`);
  });

  it('prefers script-src-elem when the policy has one', () => {
    expect(allowInlineScriptHash("script-src 'self'; script-src-elem 'self'", HASH)).toBe(
      `script-src 'self'; script-src-elem 'self' ${HASH}`,
    );
  });

  it('adds an explicit script-src rather than widening default-src', () => {
    expect(allowInlineScriptHash("default-src 'self'", HASH)).toBe(
      `default-src 'self'; script-src 'self' ${HASH}`,
    );
  });

  it('leaves a policy with no script directive alone', () => {
    expect(allowInlineScriptHash('img-src *', HASH)).toBe('img-src *');
  });

  it('is idempotent', () => {
    const once = allowInlineScriptHash("script-src 'self'", HASH);

    expect(allowInlineScriptHash(once, HASH)).toBe(once);
  });
});

describe('allowRecoveryScript', () => {
  it('only touches the enforcing policy', () => {
    const headers = {
      'content-security-policy': "script-src 'self'",
      'content-security-policy-report-only': "script-src 'self'",
    };

    const out = allowRecoveryScript(headers, HASH);

    expect(out['content-security-policy']).toBe(`script-src 'self' ${HASH}`);
    // Report-only blocks nothing; editing it would suppress a report the app asked for.
    expect(out['content-security-policy-report-only']).toBe("script-src 'self'");
  });

  /**
   * An origin may send `Content-Security-Policy` more than once; `Headers` joins those fields with
   * a comma, and a browser enforces each policy separately, so the strictest one decides.
   */
  it('widens every policy the origin sent, not just the first', () => {
    const headers = { 'content-security-policy': "script-src 'self', default-src 'none'" };

    const out = allowRecoveryScript(headers, HASH);

    expect(out['content-security-policy']).toBe(
      `script-src 'self' ${HASH}, default-src 'none'; script-src 'none' ${HASH}`,
    );
  });

  it('is a no-op when the route has no policy', () => {
    expect(allowRecoveryScript({ vary: 'rsc' }, HASH)).toStrictEqual({ vary: 'rsc' });
  });

  /** A rule of `next.config` is published as the application wrote it, casing and all. */
  it('finds the policy under any casing of its name, and keeps that casing', () => {
    const headers = {
      'Content-Security-Policy': "script-src 'self'",
      'Content-Security-Policy-Report-Only': "script-src 'self'",
    };

    expect(allowRecoveryScript(headers, HASH)).toStrictEqual({
      'Content-Security-Policy': `script-src 'self' ${HASH}`,
      'Content-Security-Policy-Report-Only': "script-src 'self'",
    });
  });
});

describe('recoveryScriptCspSource', () => {
  it('hashes exactly the script the recovery document carries', async () => {
    const html = buildRecoveryHtml();
    // What the document holds between its script's tags: it carries the one.
    const open = '<script>';
    const script = html.slice(html.indexOf(open) + open.length, html.lastIndexOf('</script>'));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script));
    const base64 = btoa(String.fromCodePoint(...new Uint8Array(digest)));

    await expect(recoveryScriptCspSource()).resolves.toBe(`'sha256-${base64}'`);
  });
});

/** What a real Next.js app on Vercel sends, with the nonce it mints afresh on every response. */
function policyWith(nonce: string): string {
  return (
    `default-src 'none'; script-src 'self' 'nonce-${nonce}' ${HASH} 'strict-dynamic'; ` +
    `style-src 'self' 'nonce-${nonce}'; object-src 'none'`
  );
}

describe('withoutCspNonces', () => {
  it('removes every nonce and keeps everything else', () => {
    expect(withoutCspNonces(policyWith('first=='))).toBe(
      `default-src 'none'; script-src 'self' ${HASH} 'strict-dynamic'; ` +
        "style-src 'self'; object-src 'none'",
    );
  });

  /** The point of the normalisation: two responses that differ only in their nonces agree. */
  it('makes two responses that differ only by their nonce identical', () => {
    expect(withoutCspNonces(policyWith('second=='))).toBe(withoutCspNonces(policyWith('first==')));
  });

  /**
   * `Headers` joins repeated fields with a comma, and a browser enforces each policy on its own.
   *
   * A directive whose only source was a nonce is left with none, which is a directive that allows
   * nothing — the strictest reading, and the only safe one when the thing it allowed cannot be
   * reproduced. Under a report-only policy that is a report rather than a blocked script.
   */
  it('handles a value carrying more than one policy', () => {
    const joined = "script-src 'nonce-a', script-src 'nonce-b' 'self'";

    expect(withoutCspNonces(joined)).toBe("script-src, script-src 'self'");
  });

  it('leaves a policy with no nonce alone', () => {
    expect(withoutCspNonces("default-src 'self'")).toBe("default-src 'self'");
  });
});

const PLACEHOLDER = "'nonce-{ppr}'";
const MINTED = 'Y2xvdWRmbGFyZQ==';

describe('withCspNoncePlaceholder', () => {
  /**
   * Removing a nonce loses the one thing the edge needs: which directives the origin gave one to.
   * The placeholder is what two samples of a route agree on where the value never does.
   */
  it('stands in for every nonce and leaves everything else alone', () => {
    expect(withCspNoncePlaceholder(policyWith('first=='))).toBe(
      `default-src 'none'; script-src 'self' ${PLACEHOLDER} ${HASH} 'strict-dynamic'; ` +
        `style-src 'self' ${PLACEHOLDER}; object-src 'none'`,
    );
  });

  it('makes two responses that differ only by their nonce identical', () => {
    expect(withCspNoncePlaceholder(policyWith('second=='))).toBe(
      withCspNoncePlaceholder(policyWith('first==')),
    );
  });

  /** Two nonces in one directive would otherwise name the placeholder twice. */
  it('names the placeholder once however many nonces a directive had', () => {
    expect(withCspNoncePlaceholder("script-src 'nonce-a' 'nonce-b' 'self'")).toBe(
      `script-src ${PLACEHOLDER} 'self'`,
    );
  });

  it('leaves a policy with no nonce alone', () => {
    expect(withCspNoncePlaceholder("default-src 'self'")).toBe("default-src 'self'");
  });
});

describe('applyCspNonce', () => {
  it('replaces the placeholder wherever the origin had put a nonce', () => {
    const stored = withCspNoncePlaceholder(policyWith('proof-time=='));

    const served = applyCspNonce(stored, MINTED);

    expect(served).toBe(
      `default-src 'none'; script-src 'self' 'nonce-${MINTED}' ${HASH} 'strict-dynamic'; ` +
        `style-src 'self' 'nonce-${MINTED}'; object-src 'none'`,
    );
    expect(hasCspNoncePlaceholder(served)).toBe(false);
  });

  /**
   * A policy set at request time — by a middleware that mints its own, as Next.js documents — names
   * its own nonce, under `style-src` as much as `script-src`. The edge stamps its nonce on every
   * element that carried one, so each directive that named a nonce has to name the edge's instead.
   */
  it('replaces every nonce a policy set at request time names', () => {
    const live = "script-src 'nonce-mw==' 'strict-dynamic'; style-src 'self' 'nonce-mw=='";

    expect(applyCspNonce(live, MINTED)).toBe(
      `script-src 'nonce-${MINTED}' 'strict-dynamic'; style-src 'self' 'nonce-${MINTED}'`,
    );
  });

  it('still gives scripts the nonce when only styles named one', () => {
    expect(applyCspNonce("script-src 'self'; style-src 'nonce-mw=='", MINTED)).toBe(
      `script-src 'self' 'nonce-${MINTED}'; style-src 'nonce-${MINTED}'`,
    );
  });

  /** The opt-in is that the edge takes nonces over, so a policy that named none is given one. */
  it('adds a nonce to a policy that never had one', () => {
    expect(applyCspNonce("script-src 'self'", MINTED)).toBe(`script-src 'self' 'nonce-${MINTED}'`);
  });

  /**
   * Not consulted, deliberately. A rule that declined on some policies would make what is in force
   * differ per project with nothing saying so; the resulting `'unsafe-inline'` break is for a host to
   * report instead (`permitsAnyInlineScript`).
   */
  it('adds a nonce even where the policy allows any inline script', () => {
    expect(applyCspNonce("script-src 'self' 'unsafe-inline'", MINTED)).toBe(
      `script-src 'self' 'unsafe-inline' 'nonce-${MINTED}'`,
    );
  });

  /** Only `default-src` constrains scripts: widening it would relax every other fetch type. */
  it('adds an explicit script-src when only default-src governs scripts', () => {
    expect(applyCspNonce("default-src 'self'", MINTED)).toBe(
      `default-src 'self'; script-src 'self' 'nonce-${MINTED}'`,
    );
  });

  /** Inventing a directive would newly forbid every script the document loads. */
  it('leaves a policy that constrains scripts nowhere alone', () => {
    expect(applyCspNonce("img-src 'self'", MINTED)).toBe("img-src 'self'");
  });

  it('applies to every policy a comma-joined value carries', () => {
    expect(applyCspNonce("script-src 'self', script-src 'none'", MINTED)).toBe(
      `script-src 'self' 'nonce-${MINTED}', script-src 'none' 'nonce-${MINTED}'`,
    );
  });
});

describe('permitsAnyInlineScript', () => {
  /** What a host reports: a minted nonce is about to stop `'unsafe-inline'` working. */
  it('recognises a policy whose inline scripts are about to be constrained', () => {
    expect(permitsAnyInlineScript("script-src 'self' 'unsafe-inline'")).toBe(true);
    expect(permitsAnyInlineScript(`script-src 'self' 'unsafe-inline' ${HASH}`)).toBe(false);
    expect(permitsAnyInlineScript("script-src 'self'")).toBe(false);
    expect(permitsAnyInlineScript("img-src 'self'")).toBe(false);
  });
});

describe('acceptsCspNonce', () => {
  /** Either the origin already put one here, or there is a directive to add one to. */
  it.each([
    { what: 'a placeholder', policy: `script-src 'self' ${PLACEHOLDER}`, accepts: true },
    { what: 'script-src', policy: "script-src 'self'", accepts: true },
    { what: 'script-src-elem', policy: "script-src-elem 'self'", accepts: true },
    { what: 'default-src', policy: "default-src 'self'", accepts: true },
    // A whole CSP for a great many applications, and giving it a `script-src` would newly forbid
    // every script the document loads.
    { what: 'frame-ancestors alone', policy: "frame-ancestors 'none'", accepts: false },
    { what: 'img-src alone', policy: "img-src 'self'", accepts: false },
  ])('recognises $what', ({ policy, accepts }) => {
    expect(acceptsCspNonce(policy)).toBe(accepts);
  });
});

describe('sandboxBlocksRecovery', () => {
  it.each([
    ["script-src 'self'; sandbox", 'sandbox without allow-scripts and allow-same-origin'],
    ['sandbox allow-same-origin allow-forms', 'sandbox without allow-scripts'],
    ['sandbox allow-scripts', 'sandbox without allow-same-origin'],
  ])('names what %s leaves recovery without', (policy, reason) => {
    expect(sandboxBlocksRecovery(policy)).toBe(reason);
  });

  it.each([
    'sandbox allow-scripts allow-same-origin',
    // Sandbox tokens are keywords, and keywords are matched without regard to case.
    'sandbox ALLOW-SCRIPTS Allow-Same-Origin',
    "default-src 'self'",
    // Only one of a comma-separated list has to sandbox for the document to be sandboxed.
    "sandbox allow-scripts allow-same-origin, script-src 'none'",
  ])('leaves %s alone', (policy) => {
    expect(sandboxBlocksRecovery(policy)).toBeUndefined();
  });
});
