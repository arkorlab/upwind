import { describe, expect, it } from 'vitest';

import { containerDefinitionSchema } from '../src/bundle/containers.ts';
import {
  durableObjectBundleIssue,
  durableObjectDeclarationSchema,
} from '../src/bundle/durable-objects.ts';

const DEFINITION = {
  image: { dockerfile: 'container/Dockerfile', buildContext: '.' },
  instanceType: 'lite',
  maxInstances: 3,
};

describe('host-owned Container definitions', () => {
  it('keeps source metadata in a Durable Object declaration without a prepared image', () => {
    const declaration = {
      name: 'JOBS',
      module: 'src/jobs.ts',
      // eslint-disable-next-line unicorn/no-keyword-prefix -- The public registration field.
      className: 'Jobs',
      definitionRevision: 7,
      container: DEFINITION,
    };

    expect(durableObjectDeclarationSchema.parse(declaration)).toStrictEqual(declaration);
    expect(
      containerDefinitionSchema.parse({ ...DEFINITION, image: { reference: 'alpine:3.22' } }),
    ).toStrictEqual({ ...DEFINITION, image: { reference: 'alpine:3.22' } });
  });

  it.each([
    { dockerfile: '../Dockerfile' },
    { dockerfile: '/Dockerfile' },
    { dockerfile: 'Dockerfile', buildContext: '../outside' },
    { dockerfile: 'Dockerfile', buildContext: 'src/../outside' },
    { dockerfile: 'Dockerfile', reference: 'alpine' },
    { reference: '--platform=other' },
    { reference: 'https://registry.example/image' },
    { reference: 'image\nother' },
  ])('rejects invalid or ambiguous image sources: %o', (image) => {
    expect(containerDefinitionSchema.safeParse({ ...DEFINITION, image }).success).toBe(false);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid instance caps: %s',
    (maxInstances) => {
      expect(containerDefinitionSchema.safeParse({ ...DEFINITION, maxInstances }).success).toBe(
        false,
      );
    },
  );

  it('accepts fixed instance sizes and rejects runtime scheduling configuration', () => {
    for (const instanceType of [
      'lite',
      'basic',
      'standard-1',
      'standard-2',
      'standard-3',
      'standard-4',
    ])
      expect(containerDefinitionSchema.safeParse({ ...DEFINITION, instanceType }).success).toBe(
        true,
      );

    expect(
      containerDefinitionSchema.safeParse({ ...DEFINITION, instanceType: 'unknown' }).success,
    ).toBe(false);
    expect(
      containerDefinitionSchema.safeParse({ ...DEFINITION, schedulingPolicy: 'durable_object' })
        .success,
    ).toBe(false);
    expect(
      containerDefinitionSchema.safeParse({ ...DEFINITION, preparedImage: 'alpine:3.22' }).success,
    ).toBe(false);
  });

  it('requires Container-aware bundle versions without changing ordinary object versions', () => {
    const declaration = durableObjectDeclarationSchema.parse({
      name: 'JOBS',
      module: 'jobs.ts',
      // eslint-disable-next-line unicorn/no-keyword-prefix -- The public registration field.
      className: 'Jobs',
      container: DEFINITION,
    });
    const functions = { durableObjects: { JOBS: {} } };
    for (const v of [7, 8]) {
      expect(
        durableObjectBundleIssue({ v, durableObjects: [declaration], functions }),
      ).toBeUndefined();
      expect(durableObjectBundleIssue({ v, durableObjects: [], functions })).toContain(
        'must match',
      );
    }
    for (const v of [5, 6]) {
      expect(durableObjectBundleIssue({ v, durableObjects: [declaration], functions })).toContain(
        'Containers require',
      );

      const ordinary = { ...declaration, container: undefined };

      expect(
        durableObjectBundleIssue({ v, durableObjects: [ordinary], functions }),
      ).toBeUndefined();
    }

    expect(
      durableObjectBundleIssue({
        v: 7,
        durableObjects: [declaration],
        functions: { durableObjects: { OTHER: {} } },
      }),
    ).toContain('must match');
  });
});
