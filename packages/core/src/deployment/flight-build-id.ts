const ROOT_ROW_PREFIX = '0:{';
const INLINE_DATA_PREFIX = 'self.__next_f.push([1,"';
const UNICODE_ESCAPE_LENGTH = 4;
const HEX_RADIX = 16;
const HEX_DIGIT = /^[\da-f]$/iu;
const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '/': '/',
  '\\': '\\',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** Decode one JSON string without buffering its contents, including split escape sequences. */
class JsonStringReader {
  #escaped = false;
  #unicode: string | undefined;
  ended = false;
  invalid = false;

  #readUnicode(char: string): string | undefined {
    if (!HEX_DIGIT.test(char)) {
      this.invalid = true;
      return undefined;
    }
    this.#unicode = (this.#unicode ?? '') + char;
    if (this.#unicode.length !== UNICODE_ESCAPE_LENGTH) {
      return undefined;
    }
    const decoded = String.fromCodePoint(Number.parseInt(this.#unicode, HEX_RADIX));
    this.#unicode = undefined;
    return decoded;
  }

  read(char: string): string | undefined {
    if (this.#unicode !== undefined) {
      return this.#readUnicode(char);
    }
    if (this.#escaped) {
      this.#escaped = false;
      if (char === 'u') {
        this.#unicode = '';
        return undefined;
      }
      const decoded = JSON_ESCAPES[char];
      this.invalid = decoded === undefined;
      return decoded;
    }
    if (char === '\\') {
      this.#escaped = true;
    } else if (char === '"') {
      this.ended = true;
    } else if (char < ' ') {
      this.invalid = true;
    } else {
      return char;
    }
    return undefined;
  }
}

type RootFieldPhase = 'key' | 'colon' | 'value' | 'after';

/**
 * Read only the top-level `b` string in Flight row zero. Next.js 16.3 appends it after the
 * nested route tree, so neither the first closing brace nor a fixed row-prefix length bounds it.
 * Other strings and nested values are skipped; even a very large row is never buffered.
 */
class FlightBuildIdReader {
  readonly #captureLimit: number;
  #prefixOffset = 0;
  #depth = 0;
  #phase: RootFieldPhase = 'key';
  #buildIdField = false;
  #string: JsonStringReader | undefined;
  #captured: string | undefined;

  constructor(captureLimit: number) {
    this.#captureLimit = captureLimit;
  }

  #readPrefix(char: string): void {
    if (this.#prefixOffset < 0) {
      return;
    }
    if (char !== ROOT_ROW_PREFIX[this.#prefixOffset]) {
      this.#prefixOffset = -1;
      return;
    }
    this.#prefixOffset += 1;
    if (this.#prefixOffset === ROOT_ROW_PREFIX.length) {
      this.#depth = 1;
      this.#phase = 'key';
      this.#buildIdField = false;
      this.#prefixOffset = -1;
    }
  }

  #readString(char: string): string | undefined {
    const reader = this.#string;
    if (reader === undefined) {
      return undefined;
    }
    const decoded = reader.read(char);
    if (reader.invalid) {
      this.#depth = 0;
      this.#captured = undefined;
      this.#string = undefined;
      return undefined;
    }
    if (decoded !== undefined && this.#captured !== undefined) {
      const limit = this.#phase === 'key' ? 1 : this.#captureLimit;
      this.#captured =
        this.#captured.length + decoded.length <= limit ? this.#captured + decoded : undefined;
    }
    if (!reader.ended) {
      return undefined;
    }
    this.#string = undefined;
    return this.#finishString();
  }

  #finishString(): string | undefined {
    const captured = this.#captured;
    this.#captured = undefined;
    if (this.#depth !== 1) {
      return undefined;
    }
    if (this.#phase === 'key') {
      this.#buildIdField = captured === 'b';
      this.#phase = 'colon';
      return undefined;
    }
    const isBuildId = this.#phase === 'value' && this.#buildIdField;
    this.#phase = 'after';
    return isBuildId && captured !== '' ? captured : undefined;
  }

  #readStructure(char: string): void {
    if (char === '{' || char === '[') {
      this.#depth += 1;
    } else if (char === '}' || char === ']') {
      this.#depth -= 1;
      this.#phase = 'after';
    } else if (this.#depth === 1) {
      this.#readFieldSeparator(char);
    }
  }

  #readFieldSeparator(char: string): void {
    if (char === ',' && this.#phase === 'after') {
      this.#phase = 'key';
      this.#buildIdField = false;
    } else if (char === ':' && this.#phase === 'colon') {
      this.#phase = 'value';
    } else if (char > ' ' && this.#phase === 'value') {
      // A non-string primitive cannot be a build id. Its comma ends the value.
      this.#phase = 'after';
    }
  }

  read(char: string): string | undefined {
    if (this.#string !== undefined) {
      return this.#readString(char);
    }
    if (char === '\n') {
      this.#prefixOffset = 0;
      this.#depth = 0;
      return undefined;
    }
    if (this.#depth === 0) {
      this.#readPrefix(char);
    } else if (char === '"') {
      this.#string = new JsonStringReader();
      this.#captured =
        this.#depth === 1 &&
        (this.#phase === 'key' || (this.#phase === 'value' && this.#buildIdField))
          ? ''
          : undefined;
    } else {
      this.#readStructure(char);
    }
    return undefined;
  }
}

/** Join the decoded Flight text across Next.js's independently escaped inline push calls. */
class InlineFlightBuildIdReader {
  readonly #flight: FlightBuildIdReader;
  #prefixOffset = 0;
  #string: JsonStringReader | undefined;

  constructor(captureLimit: number) {
    this.#flight = new FlightBuildIdReader(captureLimit);
  }

  read(char: string): string | undefined {
    if (this.#string !== undefined) {
      const decoded = this.#string.read(char);
      if (this.#string.invalid) {
        // A malformed inline string cannot be joined to the next valid Flight fragment.
        this.#flight.read('\n');
      }
      if (this.#string.ended || this.#string.invalid) {
        this.#string = undefined;
      }
      return decoded === undefined ? undefined : this.#flight.read(decoded);
    }
    this.#prefixOffset =
      char === INLINE_DATA_PREFIX[this.#prefixOffset]
        ? this.#prefixOffset + 1
        : Number(char === INLINE_DATA_PREFIX[0]);
    if (this.#prefixOffset === INLINE_DATA_PREFIX.length) {
      this.#string = new JsonStringReader();
      this.#prefixOffset = 0;
    }
    return undefined;
  }
}

/** Bounded UTF-8 decoding; parser state survives both byte windows and inline script boundaries. */
export function scanFlightBuildId(bytes: Uint8Array, windowSize: number): string | undefined {
  const decoder = new TextDecoder();
  const inline = new InlineFlightBuildIdReader(windowSize);
  const raw = new FlightBuildIdReader(windowSize);
  let rawEnabled: boolean | undefined;
  for (let start = 0; start < bytes.byteLength; start += windowSize) {
    const end = Math.min(start + windowSize, bytes.byteLength);
    const text = decoder.decode(bytes.subarray(start, end), { stream: end < bytes.byteLength });
    for (const char of text) {
      if (rawEnabled === undefined && char > ' ') {
        rawEnabled = char !== '<';
      }
      // In HTML, row-shaped page text is application content; only inline Flight counts.
      const found = inline.read(char) ?? (rawEnabled === true ? raw.read(char) : undefined);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}
