/** Shared by the Function build and the development loader; no transport runs at build time. */
export const WEBSOCKET_RESPONSE_SYMBOL = 'upwind.websocket-response@1';

const COOKIE_MARK = 'No response is returned from route handler';
const SEND_MARKS = ['x-middleware-set-cookie', 'proxy-authenticate', 'originalResponse'];
const STATUS =
  /(?<![\w$.])(?<node>[\w$]+)\.statusCode\s*=\s*(?<response>[\w$]+)\.status\s*[,;]\s*\k<node>\.statusMessage\s*=\s*\k<response>\.statusText/gu;

const ORIGINAL =
  /(?:const|let)\s*\{\s*originalResponse(?:\s*:\s*[\w$]+)?\s*\}\s*=\s*(?<node>[\w$]+)\s*;/gu;
const COOKIE_RESPONSE =
  /new Response\((?<response>[\w$]+)\.body,\s*\{\s*status:\s*\k<response>\.status,\s*statusText:\s*\k<response>\.statusText,\s*headers(?:\s*:\s*[\w$]+)?\s*\}\)/gu;

function hasSend(source: string): boolean {
  return SEND_MARKS.every((mark) => source.includes(mark));
}

function hasCookies(source: string): boolean {
  return source.includes(COOKIE_MARK) && source.includes('mutableCookies');
}

/** The destructured response must be the one whose body the serializer sends next. */
function sendsBodyAfter(source: string, declaration: RegExpExecArray, response: string): boolean {
  let next = source.slice(declaration.index + declaration[0].length).trimStart();
  while (next.startsWith('//')) {
    const end = next.indexOf('\n');
    if (end === -1) return false;
    next = next.slice(end + 1).trimStart();
  }
  return next.replace(/^if\s*\(\s*/u, '').startsWith(`${response}.body`);
}

export function isWebSocketResponseBridgeSource(source: string): boolean {
  return hasSend(source) || hasCookies(source);
}

/**
 * Keep a native upgrade out of Node's HTTP serializer, after Next has merged response headers.
 * The callback belongs to this ServerResponse, so concurrent requests never share a handoff.
 * Cookie merging must keep the same socket before the response reaches that callback.
 */
export function webSocketResponseBridge(source: string): {
  readonly contents: string;
  readonly edits: number;
} {
  let contents = source;
  let edits = 0;
  if (hasSend(source)) {
    const declarations = [...source.matchAll(ORIGINAL)];
    const insertions: { readonly index: number; readonly text: string }[] = [];
    for (const status of source.matchAll(STATUS)) {
      const node = status.groups?.['node'];
      const response = status.groups?.['response'];
      const declaration = declarations.find(
        (candidate) => candidate.index > status.index && candidate.groups?.['node'] === node,
      );
      if (
        node === undefined ||
        response === undefined ||
        declaration === undefined ||
        !sendsBodyAfter(source, declaration, response)
      ) {
        throw new Error('websocket-response-bridge: unsupported Next response serializer');
      }
      insertions.push({
        index: declaration.index,
        text:
          `if(${response}.status===101&&${response}.webSocket!=null){` +
          `const send=${node}.originalResponse[Symbol.for(${JSON.stringify(WEBSOCKET_RESPONSE_SYMBOL)})];` +
          'if(typeof send!=="function")throw new Error("WebSocket responses require an upgrade transport");' +
          `return send(${response});}`,
      });
    }
    if (insertions.length === 0) {
      throw new Error('websocket-response-bridge: Next response serializer was not found');
    }
    for (const insertion of insertions.toReversed()) {
      contents =
        contents.slice(0, insertion.index) + insertion.text + contents.slice(insertion.index);
    }
    edits += insertions.length;
  }
  if (hasCookies(source)) {
    let cookies = 0;
    contents = contents.replaceAll(COOKIE_RESPONSE, (match: string, ...args: unknown[]) => {
      const groups = args.at(-1) as { readonly response: string };
      cookies += 1;
      return match.replace(/\}\)$/u, () => `,webSocket:${groups.response}.webSocket})`);
    });
    const expected = source.split(COOKIE_MARK).length - 1;
    if (cookies !== expected) {
      throw new Error(
        `websocket-response-bridge: expected ${String(expected)} cookie response(s), found ${String(cookies)}`,
      );
    }
    edits += cookies;
  }
  return { contents, edits };
}
