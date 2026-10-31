import { describe, expect, it } from 'vitest';

import { publicationDeadline } from '../src/cache/publication.ts';
import { resourceSnapshotTag } from '../src/cache/resource-snapshot.ts';
import { PLATFORM_REQUEST_HEADERS } from '../src/paas/protocol.ts';
import {
  enforcePublicationPolicy,
  markPublicationPolicy,
  publicationPolicy,
  PUBLICATION_POLICY_HEADER,
  withPublicationPolicy,
} from '../src/paas/publication-policy.ts';
import {
  parseResumePublicationHeader,
  PUBLICATION_RESUME_HEADER,
  resumePublicationHeader,
} from '../src/paas/publication-resume.ts';
import { handedOnAsSent } from '../src/request/headers.ts';

const ID = 'a'.repeat(64);
const early = `upwind:publication:v1:${ID}:60000`;
const late = `upwind:publication:v1:${ID}:90000`;

describe('selected publication grant transport', () => {
  it('carries the selected bounds without substituting a renewed parent bound', () => {
    const encoded = resumePublicationHeader(['ordinary-resource', late, early]);
    const selected = parseResumePublicationHeader(encoded ?? null);

    expect(selected).toStrictEqual([early]);
    expect(publicationDeadline(selected)).toBe(60_000);
    expect(resumePublicationHeader(['ordinary-resource'])).toBeUndefined();
  });

  it.each([`upwind:publication:private:${ID}`, 'upwind:publication:v1:bad:60000'])(
    'refuses non-public authority proof on the transport (%s)',
    (tag) => {
      expect(() => resumePublicationHeader([tag])).toThrow('Invalid selected publication grants.');
      expect(() => parseResumePublicationHeader(JSON.stringify([tag]))).toThrow(
        'Invalid selected publication grants.',
      );
    },
  );

  it('resumes a valid generation with a thousand renewed tags using the original minimum', () => {
    const tags = Array.from(
      { length: 1024 },
      (_, index) => `upwind:publication:v1:${ID}:${String(60_000 + index)}`,
    );
    const header = resumePublicationHeader(tags);

    expect(parseResumePublicationHeader(header ?? null)).toStrictEqual([early]);
    expect(publicationDeadline(parseResumePublicationHeader(header ?? null))).toBe(60_000);
  });

  it('retains original resource witnesses and canonical tags alongside renewed children', () => {
    const old = resourceSnapshotTag({ resourceId: ID, version: 4 });
    const fresh = resourceSnapshotTag({ resourceId: ID, version: 9 });
    const selected = parseResumePublicationHeader(
      resumePublicationHeader(['source-resource', early, old, fresh]) ?? null,
    );

    expect(selected).toContain('source-resource');
    expect(selected).toContain(old);
    expect(selected).not.toContain(fresh);
  });

  it('encodes canonical Unicode resource tags as bounded HTTP-safe JSON', () => {
    const canonical = 'resource:界😀';
    const witness = resourceSnapshotTag({ resourceId: ID, version: 4 });
    const encoded = resumePublicationHeader([early, witness, canonical]);
    const headers = new Headers({ [PUBLICATION_RESUME_HEADER]: encoded ?? '' });

    expect(parseResumePublicationHeader(headers.get(PUBLICATION_RESUME_HEADER))).toContain(
      canonical,
    );
    expect(() => {
      return resumePublicationHeader([
        early,
        witness,
        ...Array.from({ length: 8 }, (_, index) => `${String(index)}:${'界'.repeat(200)}`),
      ]);
    }).toThrow('transport bound');
  });

  it('bounds the handoff and reserves it from public application requests', () => {
    expect(() => parseResumePublicationHeader(' '.repeat(8193))).toThrow('transport bound');
    expect(() => {
      return resumePublicationHeader(
        Array.from(
          { length: 65 },
          (_, index) => `upwind:publication:v1:${index.toString(16).padStart(64, '0')}:60000`,
        ),
      );
    }).toThrow('Invalid selected publication grants.');
    expect(PLATFORM_REQUEST_HEADERS).toContain(PUBLICATION_RESUME_HEADER);
    expect(handedOnAsSent(PUBLICATION_RESUME_HEADER)).toBe(false);
    expect(handedOnAsSent(PUBLICATION_POLICY_HEADER)).toBe(false);
  });
});

describe('publication restrictions after final header decisions', () => {
  it('restores the producer restriction after a later rule makes the response public', () => {
    const source = markPublicationPolicy(
      new Response('bounded', { headers: { 'cache-control': 'private, no-store, no-transform' } }),
    );
    source.headers.set('cache-control', 'public, max-age=3600');
    source.headers.set('cdn-cache-control', 'public, max-age=3600');
    const response = withPublicationPolicy(source);

    expect(response.headers.get('cache-control')).toBe('private, no-store, no-transform');
    expect(response.headers.has('cdn-cache-control')).toBe(false);
  });

  it('keeps a later no-store restriction and matches exact directive names', () => {
    const source = markPublicationPolicy(
      new Response('bounded', { headers: { 'cache-control': 'private, x-no-store-hint=1' } }),
    );
    const restriction = publicationPolicy(source.headers);
    const headers = new Headers({ 'cache-control': 'no-store, no-transform' });
    enforcePublicationPolicy(headers, restriction);

    expect(restriction).toStrictEqual({ mode: 'revalidate', noTransform: false });
    expect(headers.get('cache-control')).toBe('private, no-store, no-transform');

    const ordinary = new Response('public', {
      headers: { 'cache-control': 'public, max-age=3600' },
    });

    expect(withPublicationPolicy(ordinary)).toBe(ordinary);
  });
});
