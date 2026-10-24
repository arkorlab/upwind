import { describe, expect, it } from 'vitest';

import {
  BASE58_ID_LENGTH,
  DNS_LABEL_LENGTH,
  formatId,
  fromDnsLabel,
  ID_PAYLOAD_BITS,
  createDerivedId,
  isId,
  createId,
  createIdPayload,
  parseId,
  payloadFromUuid,
  toDnsLabel,
  uuidFromPayload,
} from '../src/util/id.ts';

const SAMPLE_COUNT = 200;
const UUID_V4 = '0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';

describe('payloadFromUuid', () => {
  it('round-trips a UUIDv4 through the 122-bit payload', () => {
    const payload = payloadFromUuid(UUID_V4);

    expect(payload).toBeDefined();
    expect(uuidFromPayload(payload ?? 0n)).toBe(UUID_V4);
    expect(payload ?? 0n).toBeLessThan(2n ** BigInt(ID_PAYLOAD_BITS));
  });

  it('ignores the version and variant bits, which carry no entropy', () => {
    const other = payloadFromUuid('0a1b2c3d-4e5f-4a7b-9c9d-0e1f2a3b4c5d');

    expect(payloadFromUuid(UUID_V4)).not.toBe(other);
    expect(payloadFromUuid(UUID_V4.toUpperCase())).toBe(payloadFromUuid(UUID_V4));
  });

  it('rejects malformed or non-v4 input', () => {
    expect(payloadFromUuid('not-a-uuid')).toBeUndefined();
    expect(payloadFromUuid('0a1b2c3d-4e5f-4a7b-cc9d-0e1f2a3b4c5d')).toBeUndefined();
    expect(payloadFromUuid('')).toBeUndefined();
  });
});

describe('createId', () => {
  it('produces a fixed-width, prefixed Base58 id', () => {
    const id = createId('site');

    expect(id).toMatch(/^site_[1-9A-HJ-NP-Za-km-z]{21}$/u);
    expect(id).toHaveLength('site_'.length + BASE58_ID_LENGTH);
  });

  it('is unique across many draws', () => {
    const ids = Array.from({ length: SAMPLE_COUNT }, () => createId('run'));

    expect(new Set(ids).size).toBe(SAMPLE_COUNT);
  });

  it('pads small payloads so the width never varies', () => {
    expect(formatId('site', 0n)).toBe(`site_${'1'.repeat(BASE58_ID_LENGTH)}`);
    expect(formatId('site', 1n)).toBe(`site_${'1'.repeat(BASE58_ID_LENGTH - 1)}2`);
  });
});

describe('parseId', () => {
  it('accepts its own output and rejects everything else', () => {
    const payload = createIdPayload();
    const id = formatId('site', payload);

    expect(parseId('site', id)).toBe(payload);
    expect(isId('site', id)).toBe(true);
    expect(parseId('run', id)).toBeUndefined();
    expect(parseId('site', `site_${'1'.repeat(BASE58_ID_LENGTH - 1)}`)).toBeUndefined();
    expect(parseId('site', 'site_0OIl00000000000000000')).toBeUndefined();
    expect(parseId('site', `site_${'z'.repeat(BASE58_ID_LENGTH)}`)).toBeUndefined();
  });
});

describe('toDnsLabel', () => {
  it('renders the same payload as a case-insensitive label', () => {
    const payload = createIdPayload();
    const label = toDnsLabel(payload);

    expect(label).toMatch(/^[a-z2-7]{25}$/u);
    expect(label).toHaveLength(DNS_LABEL_LENGTH);
    expect(fromDnsLabel(label)).toBe(payload);
    expect(label).toBe(label.toLowerCase());
  });

  it('starts with a letter, so the label is a legal hostname component', () => {
    const labels = Array.from({ length: SAMPLE_COUNT }, () => toDnsLabel(createIdPayload()));

    expect(labels.every((label) => /^[a-h]/u.test(label))).toBe(true);
    expect(new Set(labels).size).toBe(SAMPLE_COUNT);
  });

  it('rejects labels of the wrong width or alphabet', () => {
    expect(fromDnsLabel('a'.repeat(DNS_LABEL_LENGTH - 1))).toBeUndefined();
    expect(fromDnsLabel(`A${'a'.repeat(DNS_LABEL_LENGTH - 1)}`)).toBeUndefined();
    expect(fromDnsLabel(`1${'a'.repeat(DNS_LABEL_LENGTH - 1)}`)).toBeUndefined();
    expect(fromDnsLabel('7'.repeat(DNS_LABEL_LENGTH))).toBeUndefined();
  });
});

describe('createDerivedId', () => {
  /**
   * A store without an interactive transaction cannot make "look, then create" atomic. A derived
   * id makes the primary key the serialization point: the loser of a race gets a constraint error
   * rather than writing a second row.
   */
  it('is stable for a seed and of the shape a minted id has', async () => {
    const first = await createDerivedId('org', 'personal-organization:user_1');
    const second = await createDerivedId('org', 'personal-organization:user_1');

    expect(first).toBe(second);
    expect(isId('org', first)).toBe(true);
  });

  it('separates seeds that differ by one character', async () => {
    const first = await createDerivedId('org', 'personal-organization:user_1');
    const second = await createDerivedId('org', 'personal-organization:user_2');

    expect(first).not.toBe(second);
  });
});
