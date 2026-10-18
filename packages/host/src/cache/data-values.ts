import * as z from '@stayingupwind/core/schema';

const KIB = 1024;
const INLINE_DATA_VALUE_KIB = 512;
/** A data-cache value up to this size travels inline in JSON; a larger one is stored as an artifact. */
export const MAX_INLINE_DATA_VALUE_BYTES = INLINE_DATA_VALUE_KIB * KIB;

const BASE64_GROUP_BYTES = 3;
const BASE64_GROUP_CHARACTERS = 4;
const BASE64_PADDING_CODE = 0x3d;
const ASCII_SPACE = 0x20;
const ASCII_TAB = 0x09;
const ASCII_CARRIAGE_RETURN = 0x0d;
const ASCII_VERTICAL_TAB = 0x0b;

/** Judge decoded size without allocating bytes; ordinary padded or unpadded values take O(1). */
function inlineValueFits(value: string): boolean {
  let padding = value.endsWith('=') ? 1 : 0;
  if (value.endsWith('==')) padding = 2;
  if (
    Math.floor((value.length * BASE64_GROUP_BYTES) / BASE64_GROUP_CHARACTERS) - padding <=
    MAX_INLINE_DATA_VALUE_BYTES
  ) {
    return true;
  }
  // atob also accepts ASCII whitespace. Only a potentially oversized spelling needs this scan;
  // do not turn the byte contract into a new limit on its encoded length or decode it to check.
  let characters = 0;
  padding = 0;
  for (let index = 0; index < value.length; index += 1) {
    // eslint-disable-next-line unicorn/prefer-code-point -- Base64 syntax and its ASCII whitespace are counted as UTF-16 code units.
    const code = value.charCodeAt(index);
    if (
      code === ASCII_SPACE ||
      (code !== ASCII_VERTICAL_TAB && code >= ASCII_TAB && code <= ASCII_CARRIAGE_RETURN)
    ) {
      continue;
    }
    characters += 1;
    padding = code === BASE64_PADDING_CODE ? Math.min(padding + 1, 2) : 0;
    if (
      Math.floor((characters * BASE64_GROUP_BYTES) / BASE64_GROUP_CHARACTERS) - 2 >
      MAX_INLINE_DATA_VALUE_BYTES
    ) {
      return false;
    }
  }
  return (
    Math.floor((characters * BASE64_GROUP_BYTES) / BASE64_GROUP_CHARACTERS) - padding <=
    MAX_INLINE_DATA_VALUE_BYTES
  );
}

const referencedDataValueSchema = z.object({
  kind: z.literal('ref'),
  artifactId: z.string().min(1),
});
const inlineDataValueSchema = z.object({
  kind: z.literal('inline'),
  base64: z.string().refine(inlineValueFits, 'inline data value exceeds its byte limit'),
});

export const dataValueSchema = z.discriminatedUnion('kind', [
  inlineDataValueSchema,
  referencedDataValueSchema,
]);

const copiedInlineDataValueSchema = z.object({
  kind: z.literal('inline'),
  base64: z.string(),
});

/** A copy's existing whole-JSON byte limit, rather than the gateway inline threshold, owns it. */
export const dataCopyValueSchema = z.discriminatedUnion('kind', [
  copiedInlineDataValueSchema,
  referencedDataValueSchema,
]);
