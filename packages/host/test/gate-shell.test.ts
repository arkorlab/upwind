import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { describe, expect, it, vi } from 'vitest';

import {
  decodeGateShell,
  encodeGateShell,
  GATE_SHELL_CONTENT_TYPE,
  GATE_SHELL_VERSION,
  type GateShellFields,
  isGateShellType,
  MAX_GATE_SHELL_BYTES,
  MAX_GATE_SHELL_HEADER_BYTES,
  reachesUncoded,
} from '../src/bindings/index.ts';

/**
 * A gate's shell as a gate lays it out and the edge reads it (`bindings/gate-shell.ts`): what one
 * says of itself survives the round trip with its two bodies byte for byte, and anything a reader
 * cannot take whole — a magic, a version, a header or bodies that are not what they say — is
 * malformed, never a shell.
 */

vi.mock(import('@stayingupwind/core/util'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, concatBytes: vi.fn(actual.concatBytes) };
});

const HTML = encodeUtf8('<!DOCTYPE html><html><body><main>a gate’s shell<!--$?-->');
/** State a resume reads as bytes: every value a byte can hold, UTF-8 or not. */
const POSTPONED = Uint8Array.from({ length: 256 }, (_, index) => index);
const FIELDS: GateShellFields = {
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', 'x-kept': 'yes' },
  route: '/hubs/[projectId]',
  resume: 'token.abc-123_~',
  seq: 7,
  id: 'shell-7',
};
const MAGIC = encodeUtf8('UPSH');
/** The bytes before a shell's header: its magic, its version, and the header's length. */
const PREFIX_LENGTH = 9;
const VERSION_OFFSET = 4;

/** A shell laid out by hand, as a gate written apart from this package lays one out. */
function laidOut(header: unknown, ...bodies: Uint8Array[]): Uint8Array {
  const headerBytes = encodeUtf8(typeof header === 'string' ? header : JSON.stringify(header));
  const prefix = new Uint8Array(PREFIX_LENGTH);
  prefix.set(MAGIC, 0);
  prefix[VERSION_OFFSET] = GATE_SHELL_VERSION;
  new DataView(prefix.buffer).setUint32(VERSION_OFFSET + 1, headerBytes.byteLength, true);
  return concatBytes([prefix, headerBytes, ...bodies]);
}

/** The header `FIELDS` measures for `HTML` and `POSTPONED`, as a reader expects it. */
function measured(changes: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ...FIELDS,
    htmlLength: HTML.byteLength,
    postponedLength: POSTPONED.byteLength,
    ...changes,
  };
}

/** The measured header without one of its fields. */
function without(field: string): Record<string, unknown> {
  const fields = Object.entries(measured()).filter(([name]) => name !== field);
  return Object.fromEntries(fields);
}

function reasonOf(bytes: Uint8Array): string | undefined {
  const decoded = decodeGateShell(bytes);
  return decoded.kind === 'malformed' ? decoded.reason : undefined;
}

describe('a gate’s shell', () => {
  it('reads back what it was laid out with, its two bodies byte for byte', () => {
    expect(decodeGateShell(encodeGateShell(FIELDS, HTML, POSTPONED))).toStrictEqual({
      kind: 'ok',
      shell: { header: measured(), html: HTML, postponed: POSTPONED },
    });
  });

  it('is laid out as its magic, its version, its header’s length, the header and the bodies', () => {
    const bytes = encodeGateShell(FIELDS, HTML, POSTPONED);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = view.getUint32(VERSION_OFFSET + 1, true);
    const header: unknown = JSON.parse(
      new TextDecoder().decode(bytes.subarray(PREFIX_LENGTH, PREFIX_LENGTH + headerLength)),
    );

    expect(bytes.subarray(0, VERSION_OFFSET)).toStrictEqual(MAGIC);
    expect(bytes[VERSION_OFFSET]).toBe(1);
    expect(header).toStrictEqual(measured());
    expect(bytes.byteLength).toBe(
      PREFIX_LENGTH + headerLength + HTML.byteLength + POSTPONED.byteLength,
    );
  });

  it('reads one laid out elsewhere, and one with no token for the resume', () => {
    const untold = without('resume');
    const decoded = decodeGateShell(laidOut(untold, HTML, POSTPONED));
    const told = laidOut(measured(), HTML, POSTPONED);

    expect(decoded.kind === 'ok' && decoded.shell.header).toStrictEqual(untold);
    expect(decodeGateShell(told).kind).toBe('ok');
  });

  const headerOnly = laidOut(measured());
  const shell = laidOut(measured(), HTML, POSTPONED);

  it.each([
    ['no magic', concatBytes([encodeUtf8('UPSX'), headerOnly.subarray(VERSION_OFFSET)])],
    ['fewer bytes than its prefix', MAGIC],
    ['a version it does not read', shell.with(VERSION_OFFSET, 2)],
    ['a header that is not JSON', laidOut('{"status":', HTML, POSTPONED)],
    ['a header that is not UTF-8', concatBytes([laidOut('\0'), POSTPONED]).with(9, 0xff)],
    ['a header that is an array', laidOut([measured()], HTML, POSTPONED)],
    ['bodies longer than it says', laidOut(measured(), HTML, POSTPONED, MAGIC)],
    ['bodies shorter than it says', laidOut(measured(), HTML)],
    ['no postponed state', laidOut(measured({ postponedLength: 0 }), HTML)],
  ])('is malformed with %s', (_, bytes) => {
    expect(decodeGateShell(bytes).kind).toBe('malformed');
  });

  it.each([
    ['status'],
    ['headers'],
    ['route'],
    ['htmlLength'],
    ['postponedLength'],
    ['seq'],
    ['id'],
  ])('is malformed without %s', (field) => {
    const bytes = laidOut(without(field), HTML, POSTPONED);

    expect(reasonOf(bytes)).toBe('header holds no shell');
  });

  it.each([
    ['a status that is no integer', { status: 200.5 }],
    ['a header named in capitals', { headers: { 'Content-Type': 'text/html' } }],
    ['a header named past a token', { headers: { 'x kept': 'yes' } }],
    ['a header value that breaks a line', { headers: { 'x-kept': 'a\r\nset-cookie: b' } }],
    ['a header value no header holds', { headers: { 'x-kept': 'ā' } }],
    ['a header value that is no text', { headers: { 'x-kept': 1 } }],
    ['a route that is no path', { route: 'hubs/[projectId]' }],
    ['a route of half a character', { route: '/hubs/\u{D800}' }],
    ['a negative length', { htmlLength: -1 }],
    ['a token a header would change', { resume: ' token' }],
    ['a token no header holds', { resume: 'tökén' }],
    ['an empty token', { resume: '' }],
    ['a sequence of none', { seq: 0 }],
    ['an empty id', { id: '' }],
  ])('is malformed with %s', (_, changes) => {
    const bytes = laidOut(measured(changes), HTML, POSTPONED);

    expect(reasonOf(bytes)).toBe('header holds no shell');
  });

  it('is malformed with a header past its bound, whatever follows it', () => {
    const bytes = laidOut(measured(), HTML, POSTPONED);
    new DataView(bytes.buffer).setUint32(VERSION_OFFSET + 1, MAX_GATE_SHELL_HEADER_BYTES + 1, true);
    const cut = laidOut(measured()).subarray(0, PREFIX_LENGTH + 1);

    expect(reasonOf(bytes)).toBe('header larger than a header may be');
    expect(reasonOf(cut)).toBe('header length exceeds the shell');
  });

  it('is malformed past the most a shell may take', () => {
    const postponed = new Uint8Array(MAX_GATE_SHELL_BYTES);
    const bytes = laidOut(measured({ postponedLength: postponed.byteLength }), HTML, postponed);

    expect(reasonOf(bytes)).toBe('larger than a shell may be');
    expect(() => encodeGateShell(FIELDS, HTML, postponed)).toThrow('gate shell too large');
  });

  it('is refused past the most a shell may take before a byte of it is copied', () => {
    const postponed = new Uint8Array(MAX_GATE_SHELL_BYTES);
    vi.mocked(concatBytes).mockClear();

    expect(() => encodeGateShell(FIELDS, HTML, postponed)).toThrow('gate shell too large');
    expect(concatBytes).not.toHaveBeenCalled();
  });

  it.each([
    ['no postponed state', FIELDS, new Uint8Array()],
    ['a field no shell holds', { ...FIELDS, route: 'no path' }, POSTPONED],
    [
      'a header past its bound',
      { ...FIELDS, id: 'x'.repeat(MAX_GATE_SHELL_HEADER_BYTES) },
      POSTPONED,
    ],
  ])('is not laid out with %s', (_, fields, postponed) => {
    expect(() => encodeGateShell(fields, HTML, postponed)).toThrow(/gate shell/u);
  });

  it.each([
    ['', true],
    ['identity', true],
    ['gzip', true],
    ['br', true],
    ['GZip', true],
    ['BR', true],
    ['deflate', false],
    ['x-gzip', false],
    ['gzip, br', false],
    ['gzip,', false],
    ['zstd', false],
  ])('says whether an answer in `%s` reaches its host as it was written', (coding, uncoded) => {
    const headers = new Headers(coding === '' ? {} : { 'content-encoding': coding });

    expect(reachesUncoded(headers)).toBe(uncoded);
  });

  it.each([
    [GATE_SHELL_CONTENT_TYPE, true],
    ['Application/Vnd.Upwind.Shell; v=1', true],
    ['application/vnd.upwind.shell+json', false],
    ['text/html', false],
    [null, false],
  ])('says whether %s is a shell’s type', (type, isShell) => {
    expect(isGateShellType(type)).toBe(isShell);
  });
});
