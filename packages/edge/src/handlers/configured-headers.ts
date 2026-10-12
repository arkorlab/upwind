/**
 * Setting a header a `next.config` rule gives a request, whose name may not be one a header can have.
 *
 * A rule may put what the request's path captured into a header's name, as Next.js lets it
 * (`x-slug-:slug`), and what comes out is whatever the visitor's URL made of it: `x-$1` over a
 * capture that spans segments is `x-a/b`. `Headers` refuses such a name with a throw, which failed
 * the whole answer — the file, the image — over one header the application could not have sent
 * either. Left off instead, and the rest of the answer is the application's. A document the edge
 * composes is not at risk: the rules reach it only through the shell's allowlist of names.
 *
 * A `try` around the call rather than a check before it, so a header that is fine costs nothing
 * more on a request.
 */
export function setConfigured(headers: Headers, name: string, value: string): void {
  try {
    headers.set(name, value);
  } catch {
    // Not a header, on this request: left off.
  }
}

/** The same, under what the answer already has: a header it holds stands. */
export function setConfiguredUnder(headers: Headers, name: string, value: string): void {
  try {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  } catch {
    // As above: `has` refuses such a name as `set` does.
  }
}
