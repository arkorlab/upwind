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
