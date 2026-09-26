/**
 * The format an optimized image goes out in: the client's `Accept` against the formats the
 * application offers, as Next.js decides it (`@hapi/accept`'s `mediaType`, then a check that the
 * header names the type literally — a wildcard never picks a format). The highest `q` wins; among
 * equals, the application's order.
 */

interface Offer {
  readonly type: string;
  readonly q: number;
}

const DEFAULT_Q = 1;

function parseAccept(accept: string): Offer[] {
  const offers: Offer[] = [];
  for (const entry of accept.split(',')) {
    const [rawType, ...params] = entry.split(';');
    const type = rawType?.trim().toLowerCase();
    if (type === undefined || type === '') {
      continue;
    }
    let q = DEFAULT_Q;
    for (const param of params) {
      const [name, value] = param.split('=', 2);
      if (value !== undefined && name?.trim().toLowerCase() === 'q') {
        const parsed = Number.parseFloat(value.trim());
        q = Number.isNaN(parsed) ? 0 : parsed;
      }
    }
    offers.push({ type, q });
  }
  return offers;
}

/** The format to serve, or `''` when the client names none the application offers. */
export function negotiateImageFormat(accept: string, formats: readonly string[]): string {
  if (accept === '' || formats.length === 0) {
    return '';
  }
  const offers = parseAccept(accept);
  let chosen = '';
  let chosenQ = 0;
  for (const format of formats) {
    const offer = offers.find((candidate) => candidate.type === format);
    if (offer !== undefined && offer.q > chosenQ) {
      chosen = format;
      chosenQ = offer.q;
    }
  }
  return chosen;
}
