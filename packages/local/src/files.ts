import { headerRulesFor, type StaticFileEntry } from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import { layStoredConfiguredOver } from '@stayingupwind/edge/internal/handlers/configured-headers.ts';

import {
  answeredBy,
  answerTo,
  type CheckedStack,
  CLAIMED,
  cookieScopeOf,
  EDGE_HEADER,
  failed,
  FROM_STORAGE,
  middlewareAnswered,
  middlewareHeadersOnly,
  policyFailure,
  skipped,
  traced,
  type Verdict,
  edgeReads,
} from './answers.ts';
import { RANGE_BYTES } from './asked-again.ts';
import { fileRequestsFor, type Sampled } from './browsers.ts';
import {
  CHANGED_SELECTION,
  decisionOf,
  ignoredRewrite,
  ontoAnotherFile,
  rewrittenOntoNoFile,
  selectionChanged,
} from './file-decisions.ts';
import {
  type Decided,
  DID_NOT_RUN,
  expectationOf,
  fileFailure,
  fileHeadFailure,
} from './file-expectations.ts';
import { followUpFailure } from './follow-ups.ts';
import type { Reading } from './reading.ts';

/**
 * A file of the build, as the check asks for it (`check.ts`): answered with the bytes its digest
 * names, as the type it was written as — or a rule of `next.config` sets — and held as the edge has
 * it held (`static-file.ts` in the edge). Immutable, as the build marked it, unless a rule sets its
 * `Cache-Control`; kept from shared caches where the answer is one visitor's, for a rule the
 * request itself selected or a cookie beside it; and, where the application's middleware ran, as
 * it set it — or, where it set nothing, kept from shared caches, as the edge then keeps it. What
 * the middleware decided is read back as the edge ran it (`keptOf`). One it rewrote onto
 * another file of the build is served as that file, which is the middleware's to choose, and is
 * skipped.
 */

/** The header a rule sets a file's type by. */
const CONTENT_TYPE = 'content-type';
/** Bound simultaneous browser samples; each owns its own trace and response cleanup. */
const FILE_SAMPLES_AT_ONCE = 16;

/**
 * A request the middleware rewrote onto the file of the build at `onto`, served as that file:
 * skipped, as the middleware's to choose, where it is answered as the edge answers with that file
 * — whole, or, to a `HEAD`, its headers alone.
 */
export function rewrittenOnto(
  stack: CheckedStack,
  onto: string,
  read: {
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly answer: Reading;
    /** What the middleware decided, which ran: it rewrote the request. */
    readonly middleware: MiddlewareResult | undefined;
    /** Whether it asked for the headers alone (`HEAD`), which the edge answers from the manifest. */
    readonly head?: boolean;
  },
): Verdict {
  const target = stack.manifest.staticFiles?.[onto];
  if (target === undefined) {
    return failed(`rewritten onto ${onto}, which is no file of the build`);
  }
  // Served as that file — its bytes, its status, its type — under the rules the request it was
  // asked as selects, and held as the middleware chose, as the edge serves a rewrite onto a file.
  const middleware = read.middleware ?? DID_NOT_RUN;
  const expected = expectationOf(stack, read.url, target, { ...read, middleware });
  const failure =
    read.head === true
      ? fileHeadFailure(target, read.answer, expected)
      : fileFailure(target, read.answer, expected);
  return failure === undefined
    ? skipped(`the application's middleware rewrote it onto ${onto}`)
    : failed(`rewritten onto ${onto}, and ${failure}`);
}

/**
 * The types a file may be served as, which a browser asks for it by: the one it was written as, and
 * each a rule of `next.config` for its path sets, whatever the rule asks of a request — a page
 * loads a `text/plain` file a rule serves as `image/png`, to one request or to all, as an image —
 * but none a later rule for its path that holds for every request sets another over: the last of
 * two rules naming a header wins (`headerRulesFor`), so what the first sets no request is served.
 */
function typesOf(stack: CheckedStack, url: URL, file: StaticFileEntry): string[] {
  const { headerRules = [] } = stack.manifest;
  const setting = headerRules.flatMap((rule) => {
    const ruled = { sourceRegex: rule.sourceRegex, headers: rule.headers };
    const manifest = { ...stack.manifest, headerRules: [ruled] };
    const configured = headerRulesFor(manifest, url, edgeReads({}));
    const headers = new Headers();
    layStoredConfiguredOver(headers, configured, cookieScopeOf(stack), new Set<string>());
    const type = headers.get(CONTENT_TYPE);
    const always = (rule.has?.length ?? 0) === 0 && (rule.missing?.length ?? 0) === 0;
    return type === null ? [] : [{ type, always }];
  });
  const last = setting.findLastIndex((each) => each.always);
  const types = [
    ...(last === -1 ? [file.contentType] : []),
    ...setting.slice(Math.max(last, 0)).map((each) => each.type),
  ];
  return [...new Set(types)];
}

/**
 * A file, judged as the edge serves it: after the application's rules and middleware, which may
 * claim it (`hosted-gate.ts` in the edge), and only then from storage.
 */
export async function fileVerdict(
  stack: CheckedStack,
  asked: string,
  asking: { readonly file: StaticFileEntry; readonly prover: string },
): Promise<Verdict> {
  const { file } = asking;
  const at = new URL(asked, stack.site);
  // A file is claimed only by the rules ahead of the filesystem, as the edge judges it.
  const samples = fileRequestsFor({
    manifest: stack.manifest,
    url: at,
    exact: true,
    prover: asking.prover,
    contentTypes: typesOf(stack, at, file),
  });
  const preferred = samples[0];
  if (preferred === undefined) return skipped(CLAIMED);
  let failure: Verdict | undefined;
  let served = false;
  for (let index = 1; index < samples.length; index += FILE_SAMPLES_AT_ONCE) {
    const verdicts = await Promise.all(
      samples
        .slice(index, index + FILE_SAMPLES_AT_ONCE)
        .map((sampled) => fileSampleVerdict(stack, at, { file, sampled })),
    );
    failure = verdicts.find((verdict) => verdict.kind === 'failed');
    served ||= verdicts.some((verdict) => verdict.kind === 'ok');
    if (failure !== undefined) break;
  }
  // Finish with the original representative, keeping the ordinary witness.
  const checked = await fileSampleVerdict(stack, at, { file, sampled: preferred });
  if (failure !== undefined) return failure;
  return served && checked.kind === 'skipped' ? failed(undefined) : checked;
}

/** Each browser's answer is judged independently, with that request's own middleware trace. */
async function fileSampleVerdict(
  stack: CheckedStack,
  at: URL,
  asking: {
    readonly file: StaticFileEntry;
    readonly sampled: Sampled;
  },
): Promise<Verdict> {
  const { file, sampled } = asking;
  if (sampled.kind === 'claimed') {
    return skipped(CLAIMED);
  }
  if (sampled.kind === 'unproved') {
    return failed(sampled.reason);
  }
  // With the query it carries where a rule claims a request without it (`escaping`).
  const url = new URL(at);
  if (sampled.search !== undefined) {
    url.search = sampled.search;
  }
  await using tracing = await traced(stack, sampled.headers);
  const { headers, trace } = tracing;
  // Its first bytes kept, which a range of it is held to (`rangeFailure`).
  const answer = await answerTo(url, {
    via: stack.url,
    headers,
    headBytes: RANGE_BYTES + 1,
    headersOnly: middlewareHeadersOnly,
  });
  if (typeof answer === 'string') {
    return failed(answer);
  }
  const middleware = middlewareAnswered(answer);
  if (middleware !== undefined) {
    return skipped(middleware);
  }
  // A file of the build the Function answered instead — the same bytes, even — is one the edge
  // failed to serve, and a Function run every request pays for.
  const answered = answeredBy(answer);
  if (!answered.startsWith(FROM_STORAGE)) {
    return failed(`not answered by the edge from storage (${EDGE_HEADER}: ${answered})`);
  }
  const policy = policyFailure(stack, answer);
  if (policy !== undefined) {
    return failed(policy);
  }
  const decision = await decisionOf(stack, answer, { trace, url, sent: sampled.headers });
  if ('failure' in decision) {
    return failed(decision.failure);
  }
  const read = { file, headers: sampled.headers, answer, middleware: decision.decided };
  return await servedVerdict(stack, url, read);
}

/**
 * A file the edge answered from storage, judged as what it served: the file the middleware
 * rewrote the request onto, as that file (`rewrittenOnto`); none further where the middleware
 * changed what the request selects of it; otherwise the file itself, whole, and again for a range
 * of it and on its entity tag.
 */
async function servedVerdict(
  stack: CheckedStack,
  url: URL,
  read: {
    readonly file: StaticFileEntry;
    readonly headers: Readonly<Record<string, string>>;
    readonly answer: Reading;
    readonly middleware: Decided;
  },
): Promise<Verdict> {
  const { file, answer, middleware: decided } = read;
  // Where the middleware rewrote the request onto another file of the build, the edge serves that
  // file (`shippedFileAt`): its bytes, which are the middleware's to choose. One rewritten onto
  // itself — a query added, a locale in front — is served as itself, and judged as its own.
  const onto = ontoAnotherFile(stack, url, decided);
  if (onto !== undefined) {
    const middleware = decided === DID_NOT_RUN ? undefined : decided;
    return rewrittenOnto(stack, onto.pathname, { url, headers: read.headers, answer, middleware });
  }
  // Onto no file of the build, of which the edge serves nothing from storage: the file asked for,
  // served all the same, is the rewrite ignored.
  const nowhere = rewrittenOntoNoFile(stack, decided);
  if (nowhere !== undefined) {
    return failed(ignoredRewrite(nowhere));
  }
  if (selectionChanged(read.headers, decided)) {
    return skipped(CHANGED_SELECTION);
  }
  const expected = expectationOf(stack, url, file, read);
  const failure = fileFailure(file, answer, expected);
  if (failure !== undefined) {
    return failed(failure);
  }
  // No representation bytes were sent to compare a later range against. Its status, absent
  // body/framing and retained metadata were checked above; ordinary file follow-ups are unchanged.
  if (expected.bodylessRewrite) {
    return failed(undefined);
  }
  return failed(
    await followUpFailure(stack, url, {
      file,
      headers: read.headers,
      answer,
      etag: expected.etag,
    }),
  );
}
