import { describe, expect, it } from 'vitest';

import { applyNonceToHeaders } from '../src/handlers/csp-nonce.ts';

const CSP = 'content-security-policy';
const REPORT_ONLY = 'content-security-policy-report-only';
const POLICY = "script-src 'self'; report-to scripts";
const OTHER = 'script-src https://CDN.example/Path; report-to external';
const OWN = 'img-src data:; report-to application';

/** Each comma-delimited policy remains a separate policy, in its written order. */
function policies(headers: Headers): string[] {
  return (headers.get(REPORT_ONLY) ?? '').split(',').map((value) => value.trim());
}

/** A saved artifact's trial is repeated by delivery only where the whole sequence is absent. */
describe('report-only trials of multiple enforcing CSP policies', () => {
  it.each([false, true])(
    'keeps the whole trial once across nonce changes, strict-dynamic %s',
    (strict) => {
      const headers = new Headers({ [CSP]: `${POLICY}, ${OTHER}` });
      applyNonceToHeaders(headers, 'first', 'report-only', strict);
      const first = policies(headers);
      applyNonceToHeaders(headers, 'second', 'report-only', strict);
      applyNonceToHeaders(headers, 'third', 'report-only', strict);

      expect(policies(headers)).toHaveLength(2);
      expect(policies(headers)).toStrictEqual(
        first.map((policy) => policy.replaceAll('first', 'third')),
      );
      expect(headers.get(CSP)).toBe(`${POLICY}, ${OTHER}`);
    },
  );

  it('retains an application report-only policy beside one saved complete trial', () => {
    const headers = new Headers({ [CSP]: `${POLICY}, ${OTHER}`, [REPORT_ONLY]: OWN });
    applyNonceToHeaders(headers, 'first', 'report-only');
    const first = policies(headers);
    applyNonceToHeaders(headers, 'second', 'report-only');

    expect(policies(headers)).toHaveLength(3);
    expect(policies(headers)).toStrictEqual(
      first.map((policy) => policy.replaceAll('first', 'second')),
    );
    expect(policies(headers)[0]).toBe(OWN);
  });

  it('compares complete sequences independently of whitespace around commas', () => {
    const headers = new Headers({ [CSP]: `${POLICY}, ${OTHER}` });
    applyNonceToHeaders(headers, 'first', 'report-only');
    headers.set(REPORT_ONLY, policies(headers).join('  ,   '));
    applyNonceToHeaders(headers, 'second', 'report-only');

    expect(policies(headers)).toHaveLength(2);
    expect(headers.get(REPORT_ONLY)).toContain('  ,   ');
  });

  it('preserves repeated policies within the original enforcing sequence', () => {
    const headers = new Headers({ [CSP]: `${POLICY}, ${POLICY}` });
    applyNonceToHeaders(headers, 'first', 'report-only');
    applyNonceToHeaders(headers, 'second', 'report-only');

    expect(policies(headers)).toHaveLength(2);
    expect(policies(headers)[0]).toBe(policies(headers)[1]);
  });

  it('keeps a single-policy trial unchanged on replay', () => {
    const headers = new Headers({ [CSP]: POLICY });
    applyNonceToHeaders(headers, 'first', 'report-only');
    applyNonceToHeaders(headers, 'second', 'report-only');

    expect(policies(headers)).toHaveLength(1);
    expect(headers.get(REPORT_ONLY)).toContain("'nonce-second'");
  });

  it('keeps an application policy matching only part of the trial separate', () => {
    const headers = new Headers({ [CSP]: `${POLICY}, ${OTHER}`, [REPORT_ONLY]: POLICY });
    applyNonceToHeaders(headers, 'first', 'report-only');

    expect(policies(headers)).toHaveLength(3);
    expect(policies(headers)[0]).toBe(POLICY);
  });
});
