import type { IncomingHttpHeaders } from 'node:http';
import { Agent, request } from 'node:https';
import { performance } from 'node:perf_hooks';

import { boundedText, errorText, REQUEST_HEADERS, type Sample } from './protocol.ts';

const CACHED_TLS_SESSIONS = 100;

function headerOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/** Keep only response facts, never arbitrary response headers or request ids. */
export function markersOf(headers: IncomingHttpHeaders): Record<string, string> {
  const edge = headerOf(headers, 'x-arkor-edge');
  const id = headerOf(headers, 'x-vercel-id');
  const popEnd = id?.indexOf('::') ?? -1;
  const ray = headerOf(headers, 'cf-ray');
  const edgeFields = new Set(['cache', 'cont', 'reason', 'src']);
  const summary = edge
    ?.split(';')
    .filter((part, index) => index === 0 || edgeFields.has(part.slice(0, part.indexOf('='))));
  const markers: Record<string, string | undefined> = {
    vercelCache: headerOf(headers, 'x-vercel-cache'),
    vercelPop: popEnd > 0 ? id?.slice(0, popEnd) : undefined,
    arkorEdge: summary?.join(';'),
    colo: ray?.includes('-') === true ? ray.slice(ray.lastIndexOf('-') + 1) : undefined,
    encoding: headerOf(headers, 'content-encoding'),
    mitigated: headerOf(headers, 'x-vercel-mitigated') ?? headerOf(headers, 'cf-mitigated'),
  };
  return Object.fromEntries(
    Object.entries(markers).flatMap(([name, value]) =>
      value === undefined || value === '' ? [] : [[name, boundedText(value)]],
    ),
  );
}

export function agentFor(reuse: boolean): Agent {
  return new Agent({
    keepAlive: reuse,
    maxSockets: 1,
    maxFreeSockets: 1,
    // A new connection includes a full TLS handshake, not a cached TLS session.
    maxCachedSessions: reuse ? CACHED_TLS_SESSIONS : 0,
  });
}

/**
 * Timed from request creation through the final response headers, first body chunk and completion.
 * `response` excludes 103 Early Hints. Bytes are the encoded body bytes received; none are retained.
 * A wall-clock timer covers DNS, connection establishment and the entire body, including slow drips.
 */
export function timeRequest(url: string, agent: Agent, timeoutMs: number): Promise<Sample> {
  const started = performance.now();
  return new Promise((resolve) => {
    let status = 0;
    let headersMs: number | null = null;
    let firstByteMs: number | null = null;
    let bytes: number | null = null;
    let markers: Record<string, string> = {};
    let dnsMs: number | null = null;
    let connectMs: number | null = null;
    let tlsMs: number | null = null;
    let settled = false;
    const req = request(url, { agent, method: 'GET', headers: REQUEST_HEADERS });
    const timer = setTimeout(() => {
      req.destroy(new Error(`request exceeded ${String(timeoutMs)} ms`));
    }, timeoutMs);

    function finish(error?: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const completeMs = error === undefined ? performance.now() - started : null;
      resolve({
        status,
        ...(error !== undefined && { error: errorText(error) }),
        headersMs,
        firstByteMs: firstByteMs ?? completeMs,
        completeMs,
        bytes,
        markers,
        connection: { dnsMs, connectMs, tlsMs, reused: req.reusedSocket },
      });
    }

    req.once('socket', (socket) => {
      if (req.reusedSocket) {
        return;
      }
      let lookedUp = started;
      let connected = started;
      socket.once('lookup', () => {
        lookedUp = performance.now();
        dnsMs = lookedUp - started;
      });
      socket.once('connect', () => {
        connected = performance.now();
        connectMs = connected - lookedUp;
      });
      socket.once('secureConnect', () => {
        tlsMs = performance.now() - connected;
      });
    });
    req.once('response', (response) => {
      status = response.statusCode ?? 0;
      headersMs = performance.now() - started;
      bytes = 0;
      markers = markersOf(response.headers);
      response.on('data', (chunk: Buffer) => {
        firstByteMs ??= performance.now() - started;
        bytes = (bytes ?? 0) + chunk.byteLength;
      });
      response.once('error', finish);
      response.once('end', () => {
        finish();
      });
    });
    req.once('error', finish);
    req.end();
  });
}
