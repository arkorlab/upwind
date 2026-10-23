/**
 * Read dictionary keys without rewriting any value the application set. Reporting-Endpoints is a
 * Structured Field: commas in quoted URLs and parameters are not member separators (RFC 9651,
 * section 4.2). A malformed dictionary must not acquire report-to, which would disable report-uri's
 * fallback. This module has no dependencies and is used only when a CSP response already has
 * endpoints.
 */
interface Cursor {
  readonly text: string;
  offset: number;
}

const KEY = /^[a-z*][a-z\d_.*-]*/u;
const TOKEN = /^[a-zA-Z*][\w!#$%&'*+.^`|~:/-]*/u;
const NUMBER = /^-?\d{1,15}(?:\.\d{1,3})?/u;
const DATE = /^@-?\d{1,15}/u;
const BOOLEAN = /^\?[01]/u;
const BINARY = /^:[a-zA-Z\d+/]*={0,2}:/u;
const DISPLAY_ESCAPE = /^[0-9a-f]{2}$/u;
const DISPLAY_ESCAPE_LENGTH = 3;
const SPACES = /^ */u;
const OPTIONAL_WHITESPACE = /^[\t ]*/u;
const ASCII_SPACE = 0x20;
const ASCII_END = 0x7e;
const MAX_DECIMAL_INTEGER_DIGITS = 12;

function consume(cursor: Cursor, pattern: RegExp): string | undefined {
  const match = pattern.exec(cursor.text.slice(cursor.offset));
  if (match === null) {
    return undefined;
  }
  cursor.offset += match[0].length;
  return match[0];
}

function spaces(cursor: Cursor, tabs = false): void {
  consume(cursor, tabs ? OPTIONAL_WHITESPACE : SPACES);
}

function quoted(cursor: Cursor): boolean {
  cursor.offset += 1;
  while (cursor.offset < cursor.text.length) {
    const character = cursor.text[cursor.offset];
    cursor.offset += 1;
    if (character === '"') {
      return true;
    }
    if (character === '\\') {
      const escaped = cursor.text[cursor.offset];
      if (escaped !== '"' && escaped !== '\\') {
        return false;
      }
      cursor.offset += 1;
    } else {
      const code = character?.codePointAt(0);
      if (code === undefined || code < ASCII_SPACE || code > ASCII_END) {
        return false;
      }
    }
  }
  return false;
}

function displayString(cursor: Cursor): boolean {
  if (cursor.text[cursor.offset + 1] !== '"') {
    return false;
  }
  cursor.offset += 2;
  const start = cursor.offset;
  while (cursor.offset < cursor.text.length) {
    const character = cursor.text[cursor.offset];
    if (character === '"') {
      const value = cursor.text.slice(start, cursor.offset);
      cursor.offset += 1;
      try {
        decodeURIComponent(value);
        return true;
      } catch {
        return false;
      }
    }
    const code = character?.codePointAt(0);
    if (code === undefined || code < ASCII_SPACE || code > ASCII_END) {
      return false;
    }
    if (character === '%') {
      if (
        !DISPLAY_ESCAPE.test(
          cursor.text.slice(cursor.offset + 1, cursor.offset + DISPLAY_ESCAPE_LENGTH),
        )
      ) {
        return false;
      }
      cursor.offset += DISPLAY_ESCAPE_LENGTH;
    } else {
      // Unlike strings, display strings treat a backslash literally (RFC 9651, section 4.2.10).
      cursor.offset += 1;
    }
  }
  return false;
}

function bareItem(cursor: Cursor): boolean {
  const initial = cursor.text[cursor.offset];
  switch (initial) {
    case undefined: {
      return false;
    }
    case '"': {
      return quoted(cursor);
    }
    case '%': {
      return displayString(cursor);
    }
    case ':': {
      const value = consume(cursor, BINARY);
      if (value === undefined) {
        return false;
      }
      try {
        atob(value.slice(1, -1));
        return true;
      } catch {
        return false;
      }
    }
    case '?': {
      return consume(cursor, BOOLEAN) !== undefined;
    }
    case '@': {
      return consume(cursor, DATE) !== undefined;
    }
    default: {
      if (initial === '-' || /\d/u.test(initial)) {
        const value = consume(cursor, NUMBER);
        if (value === undefined) {
          return false;
        }
        const dot = value.indexOf('.');
        return dot === -1 || dot - (value.startsWith('-') ? 1 : 0) <= MAX_DECIMAL_INTEGER_DIGITS;
      }
      return consume(cursor, TOKEN) !== undefined;
    }
  }
}

function parameters(cursor: Cursor): boolean {
  while (cursor.text[cursor.offset] === ';') {
    cursor.offset += 1;
    spaces(cursor);
    if (consume(cursor, KEY) === undefined) {
      return false;
    }
    if (cursor.text[cursor.offset] === '=') {
      cursor.offset += 1;
      if (!bareItem(cursor)) {
        return false;
      }
    }
  }
  return true;
}

function memberValue(cursor: Cursor): boolean {
  if (cursor.text[cursor.offset] !== '(') {
    return bareItem(cursor) && parameters(cursor);
  }
  cursor.offset += 1;
  spaces(cursor);
  while (cursor.text[cursor.offset] !== ')') {
    if (!bareItem(cursor) || !parameters(cursor)) {
      return false;
    }
    const next = cursor.text[cursor.offset];
    if (next !== ' ' && next !== ')') {
      return false;
    }
    spaces(cursor);
  }
  cursor.offset += 1;
  return parameters(cursor);
}

export function reportingEndpointNames(text: string): ReadonlySet<string> | undefined {
  const cursor: Cursor = { text, offset: 0 };
  const names = new Set<string>();
  spaces(cursor);
  if (cursor.offset === text.length) {
    return names;
  }
  while (cursor.offset < text.length) {
    const key = consume(cursor, KEY);
    if (key === undefined) {
      return undefined;
    }
    names.add(key);
    if (text[cursor.offset] === '=') {
      cursor.offset += 1;
      if (!memberValue(cursor)) {
        return undefined;
      }
    } else if (!parameters(cursor)) {
      return undefined;
    }
    spaces(cursor, true);
    if (cursor.offset === text.length) {
      return names;
    }
    if (text[cursor.offset] !== ',') {
      return undefined;
    }
    cursor.offset += 1;
    spaces(cursor, true);
  }
  return undefined;
}
