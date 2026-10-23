import { describe, expect, it } from 'vitest';

import { httpDateMs } from '../src/http-dates.ts';

/** The instant `Sun, 06 Nov 1994 08:49:37 GMT` names, RFC 9110's own example. */
const EXAMPLE = Date.UTC(1994, 10, 6, 8, 49, 37);

describe('an HTTP-date, as the edge reads one for a condition on a file', () => {
  it('reads each of the three forms of the same instant', () => {
    expect(httpDateMs('Sun, 06 Nov 1994 08:49:37 GMT')).toBe(EXAMPLE);
    expect(httpDateMs('Sunday, 06-Nov-94 08:49:37 GMT')).toBe(EXAMPLE);
    expect(httpDateMs('Sun Nov  6 08:49:37 1994')).toBe(EXAMPLE);
  });

  it('reads the one leap second the grammar allows', () => {
    expect(httpDateMs('Sat, 31 Dec 2016 23:59:60 GMT')).toBe(Date.UTC(2017, 0, 1));
  });

  it('reads no date its fields do not name', () => {
    // The wrong day of the week, a day the month has not, a time of day that is none, no zone.
    expect(httpDateMs('Mon, 06 Nov 1994 08:49:37 GMT')).toBeUndefined();
    expect(httpDateMs('Thu, 31 Nov 1994 08:49:37 GMT')).toBeUndefined();
    expect(httpDateMs('Sun, 06 Nov 1994 24:00:00 GMT')).toBeUndefined();
    expect(httpDateMs('Sun, 06 Nov 1994 08:49:37')).toBeUndefined();
    // Nor what is no HTTP-date at all, which a condition is then not judged by.
    expect(httpDateMs('1')).toBeUndefined();
    expect(
      httpDateMs('Sun, 06 Nov 1994 08:49:37 GMT, Sun, 06 Nov 1994 08:49:37 GMT'),
    ).toBeUndefined();
  });
});
