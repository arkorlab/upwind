// Workers accepts Unicode header strings; outgoing values must also be valid ByteString values.
const UNTRANSPORTABLE_VALUE = /[\0\r\n\u{100}-\u{10FFFF}]/u;

export function transportableHeaderValue(value: string): boolean {
  return !UNTRANSPORTABLE_VALUE.test(value);
}
