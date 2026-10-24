import {
  EDGE_BYPASS_COOKIE_MAX_AGE_SECONDS,
  RECOVERY_LOOP_GUARD_SECONDS,
  RECOVERY_MARKER,
} from '@stayingupwind/core/request';
import { toBase64 } from '@stayingupwind/core/util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildRecoveryHtml,
  LEGACY_RECOVERY_SCRIPT_CSP_SOURCE,
  RECOVERY_SCRIPT_CSP_SOURCE,
  recoveryScriptCspSource,
  replaceLegacyRecoverySource,
} from '../src/splice/recovery.ts';

// The default script in the immutable manifests published before the storage-guard fix.
const LEGACY_SCRIPT =
  '(function(){try{var k="arkor-edge-recovery:"+location.pathname+location.search;var t=Number(sessionStorage.getItem(k)||0);if(Date.now()-t<10000){return;}sessionStorage.setItem(k,String(Date.now()));}catch(e){}document.cookie="__arkor_edge_bypass=1; Path=/; Max-Age=30; SameSite=Lax; Secure";location.reload();})();';

async function sourceOf(script: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script));
  return `'sha256-${toBase64(new Uint8Array(digest))}'`;
}

/** Run the actual emitted script, with cookies discarded as a privacy policy can require. */
function browser(fault?: 'getter' | 'getItem' | 'setItem') {
  const html = buildRecoveryHtml();
  const script = html.slice(
    html.indexOf('<script>') + '<script>'.length,
    html.lastIndexOf('</script>'),
  );
  const stored = new Map<string, string>();
  const cookie = vi.fn<(value: string) => void>();
  const reload = vi.fn();
  const location = { pathname: '/search', search: '?q=a', reload };
  const storage = {
    getItem(key: string): string | null {
      if (fault === 'getItem') throw new DOMException('Storage is blocked', 'SecurityError');
      return stored.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (fault === 'setItem') throw new DOMException('Storage is full', 'QuotaExceededError');
      stored.set(key, value);
    },
  };
  const document = {
    get cookie(): string {
      return '';
    },
    set cookie(value: string) {
      cookie(value);
    },
  };
  vi.stubGlobal('sessionStorage', storage);
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      if (fault === 'getter') throw new DOMException('Storage is blocked', 'SecurityError');
      return storage;
    },
  });
  // The emitted browser script is the test input; pass only the browser values it reads.
  // eslint-disable-next-line no-new-func, sonarjs/code-eval, @typescript-eslint/no-implied-eval -- execute the actual emitted script
  const execute = new Function('location', 'document', 'Date', script) as (
    at: typeof location,
    doc: typeof document,
    clock: { now: () => number },
  ) => void;
  return {
    run() {
      execute(location, document, { now: () => 1_000_000 });
    },
    cookie,
    reload,
    location,
    stored,
  };
}

describe('the recovery script when cookies cannot be stored', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['getter', 'getItem', 'setItem'] as const)(
    'does not reload when session storage fails at %s',
    (fault) => {
      const page = browser(fault);
      page.run();
      page.run();

      expect(page.reload).not.toHaveBeenCalled();
      expect(page.cookie).not.toHaveBeenCalled();
      expect(page.stored.size).toBe(0);
    },
  );

  it('reloads only once for each complete request when session storage works', () => {
    const page = browser();
    page.run();
    page.run();

    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(page.cookie).toHaveBeenCalledExactlyOnceWith(
      '__arkor_edge_bypass=1; Path=/; Max-Age=30; SameSite=Lax; Secure',
    );
    expect(page.stored.get('arkor-edge-recovery:/search?q=a')).toBe('1000000');

    page.location.search = '?q=b';
    page.run();
    page.run();

    expect(page.reload).toHaveBeenCalledTimes(2);
    expect(page.cookie).toHaveBeenCalledTimes(2);
    expect(page.stored.get('arkor-edge-recovery:/search?q=b')).toBe('1000000');
  });
});

describe('recovery script permissions across immutable deployments', () => {
  it('keeps the current source equal to the actual emitted default script', async () => {
    const html = buildRecoveryHtml();
    const script = html.slice(
      html.indexOf('<script>') + '<script>'.length,
      html.lastIndexOf('</script>'),
    );

    await expect(sourceOf(script)).resolves.toBe(RECOVERY_SCRIPT_CSP_SOURCE);
    await expect(recoveryScriptCspSource()).resolves.toBe(RECOVERY_SCRIPT_CSP_SOURCE);
  });

  it('keeps the legacy source bound to the frozen previous script', async () => {
    await expect(sourceOf(LEGACY_SCRIPT)).resolves.toBe(LEGACY_RECOVERY_SCRIPT_CSP_SOURCE);
    expect(LEGACY_RECOVERY_SCRIPT_CSP_SOURCE).not.toBe(RECOVERY_SCRIPT_CSP_SOURCE);
  });

  it.each([' ', '\t', '\n', '\f', '\r'])(
    'rotates a whole source after ASCII whitespace %j',
    (space) => {
      const policy = `script-src${space}${LEGACY_RECOVERY_SCRIPT_CSP_SOURCE}`;

      expect(replaceLegacyRecoverySource(policy)).toBe(
        `script-src${space}${RECOVERY_SCRIPT_CSP_SOURCE}`,
      );
    },
  );

  it('rotates every whole source without changing directive or policy boundaries', () => {
    const policy = `script-src ${LEGACY_RECOVERY_SCRIPT_CSP_SOURCE}; default-src 'none', script-src-elem ${LEGACY_RECOVERY_SCRIPT_CSP_SOURCE}`;
    const current = `script-src ${RECOVERY_SCRIPT_CSP_SOURCE}; default-src 'none', script-src-elem ${RECOVERY_SCRIPT_CSP_SOURCE}`;

    expect(replaceLegacyRecoverySource(policy)).toBe(current);
    expect(replaceLegacyRecoverySource(current)).toBe(current);
  });

  it('recognizes a policy comma without requiring rewritten whitespace', () => {
    const policy = `script-src ${LEGACY_RECOVERY_SCRIPT_CSP_SOURCE},script-src ${LEGACY_RECOVERY_SCRIPT_CSP_SOURCE}`;

    expect(replaceLegacyRecoverySource(policy)).toBe(
      `script-src ${RECOVERY_SCRIPT_CSP_SOURCE},script-src ${RECOVERY_SCRIPT_CSP_SOURCE}`,
    );
  });

  it.each([
    '',
    "script-src 'sha256-unrelated'",
    `script-src ${RECOVERY_SCRIPT_CSP_SOURCE}`,
    `report-uri https://reports.example/${LEGACY_RECOVERY_SCRIPT_CSP_SOURCE}`,
    `script-src prefix${LEGACY_RECOVERY_SCRIPT_CSP_SOURCE}`,
    `script-src ${LEGACY_RECOVERY_SCRIPT_CSP_SOURCE}suffix`,
    `script-src\v${LEGACY_RECOVERY_SCRIPT_CSP_SOURCE}`,
    `script-src ${LEGACY_RECOVERY_SCRIPT_CSP_SOURCE}\v`,
  ])('leaves unrelated sources and token lookalikes unchanged: %j', (policy) => {
    expect(replaceLegacyRecoverySource(policy)).toBe(policy);
  });
});

describe('buildRecoveryHtml', () => {
  it('sets the bypass cookie, guards against loops and closes the document', () => {
    const html = buildRecoveryHtml();

    // Everything before the marker is the escape sequence; the marker itself is what validation and
    // the tests downstream look for, so nothing may come between it and the script.
    expect(html).toContain(`${RECOVERY_MARKER}<script>`);
    expect(html).toContain('__arkor_edge_bypass=1; Path=/; Max-Age=30; SameSite=Lax; Secure');
    expect(html).toContain('sessionStorage');
    // The whole request, not its path: `/search?q=a` failing is no reason to leave the next
    // visitor to `/search?q=b` on a truncated document for the rest of the guard's window.
    expect(html).toContain('location.pathname+location.search');
    expect(html).toContain('location.reload()');
    expect(html.endsWith('</body></html>')).toBe(true);
    expect(buildRecoveryHtml({ cookieName: 'x', maxAgeSeconds: 5 })).toContain(
      'x=1; Path=/; Max-Age=5',
    );
  });

  /**
   * The continuation is cut at an arbitrary byte, so the recovery script can land in whatever
   * tokenizer state the origin was in. Every one of them has to be left before the script, or the
   * parser reads it as raw text (or as template content, which never executes) and the user is
   * stranded on the truncated document with no bypass cookie and no reload.
   *
   * Each row is the token that leaves one state: `"` closes a quoted attribute value and opens one
   * that has not started, `>` closes the tag itself, `-->` closes a comment, and a raw-text or
   * RCDATA element is left only by its own end tag. `plaintext` is the one state nothing escapes.
   */
  it.each([
    ['an attribute value', '"'],
    ['an open tag', '>'],
    // Only in SVG or MathML, where nothing but `]]>` ends one.
    ['a CDATA section', ']]>'],
    ['a comment', '-->'],
    ['a script', '</script>'],
    ['a style', '</style>'],
    ['a textarea', '</textarea>'],
    ['a title', '</title>'],
    ['a noscript', '</noscript>'],
    ['a noembed', '</noembed>'],
    ['a noframes', '</noframes>'],
    ['an iframe', '</iframe>'],
    ['an xmp', '</xmp>'],
    ['a template', '</template>'],
  ])('leaves %s before the script', (_state, closer) => {
    const html = buildRecoveryHtml();
    const escape = html.slice(0, html.indexOf(RECOVERY_MARKER));

    expect(escape).toContain(closer);
  });

  /**
   * One `</template>` closes only the innermost template, and templates nest: the escape closes
   * sixteen. It closes them after the text-holding elements, inside one of which a `</template>` is
   * still text.
   */
  it('closes templates nested inside one another, after everything else it leaves', () => {
    const html = buildRecoveryHtml();
    const escape = html.slice(0, html.indexOf(RECOVERY_MARKER));
    const templates = escape.slice(escape.indexOf('</template>'));

    expect(templates.split('</template>')).toHaveLength(17);
    expect(templates.replaceAll('</template>', '')).not.toContain('</');
  });

  /**
   * Inside SVG or MathML a `<script>` is that language's element, and a MathML one never runs. A
   * `<meta>` is a tag both hand back to HTML: it pops every foreign element down to an HTML one or
   * an integration point, where the script is HTML's. So it comes last, after everything that would
   * read it as text.
   */
  it('leaves SVG and MathML last, by a tag both hand back to HTML', () => {
    const html = buildRecoveryHtml();
    const escape = html.slice(0, html.indexOf(RECOVERY_MARKER));

    expect(escape.endsWith('</template><meta>')).toBe(true);
  });

  it('keeps the loop guard shorter than the bypass cookie', () => {
    const html = buildRecoveryHtml();
    const guardMs = /Date\.now\(\)-t<(?<ms>\d+)/u.exec(html)?.groups?.['ms'];

    // A guard that outlived the cookie would leave a repeat failure unrecovered once it expires.
    expect(RECOVERY_LOOP_GUARD_SECONDS).toBeLessThan(EDGE_BYPASS_COOKIE_MAX_AGE_SECONDS);
    expect(Number(guardMs)).toBe(RECOVERY_LOOP_GUARD_SECONDS * 1000);
  });
});
