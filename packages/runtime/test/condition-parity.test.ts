import { resolveRoutes, type RouteHas } from '@next/routing';
import { anyConditionHolds } from '@stayingupwind/core/request';
import { describe, expect, it } from 'vitest';

interface Example {
  readonly condition: RouteHas;
  readonly query?: string;
  readonly headers?: Record<string, string>;
}

const examples: Example[] = [
  {
    condition: { type: 'header', key: 'x-role', value: 'admin' },
    headers: { 'x-role': 'superadmin' },
  },
  {
    condition: { type: 'header', key: 'x-role', value: '^admin$' },
    headers: { 'x-role': 'superadmin' },
  },
  { condition: { type: 'header', key: 'x-empty' }, headers: { 'x-empty': '' } },
  { condition: { type: 'query', key: 'empty' }, query: '?empty=' },
  { condition: { type: 'query', key: 'role', value: 'admin' }, query: '?role=superadmin' },
  { condition: { type: 'query', key: 'role', value: '^admin$' }, query: '?role=user&role=admin' },
  { condition: { type: 'cookie', key: 'empty' }, headers: { cookie: 'empty=' } },
  {
    condition: { type: 'cookie', key: 'role', value: '^admin$' },
    headers: { cookie: 'role=user; role=admin' },
  },
  {
    condition: { type: 'cookie', key: 'role', value: '^admin$' },
    headers: { cookie: 'role=admin; role=user' },
  },
  { condition: { type: 'cookie', key: 'role' }, headers: { cookie: 'role =admin' } },
  { condition: { type: 'cookie', key: 'token', value: '^a=b$' }, headers: { cookie: 'token=a=b' } },
  { condition: { type: 'host', value: 'example' } },
  { condition: { type: 'header', key: 'x-pattern', value: '[' }, headers: { 'x-pattern': '[' } },
];

/** Use the installed router's middleware decision instead of copying its matcher into the test. */
async function middlewareMatches(example: Example, missing: boolean): Promise<boolean> {
  let invoked = false;
  await resolveRoutes({
    url: new URL(`https://app.example.test/page${example.query ?? ''}`),
    headers: new Headers(example.headers),
    requestBody: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    buildId: 'build',
    basePath: '',
    pathnames: ['/page'],
    routes: {
      beforeMiddleware: [],
      middlewareMatchers: [
        {
          sourceRegex: '^/page$',
          ...(missing ? { missing: [example.condition] } : { has: [example.condition] }),
        },
      ],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
    },
    invokeMiddleware: () => {
      invoked = true;
      return Promise.resolve({});
    },
  });
  return invoked;
}

describe('edge conditions agree with the installed Next.js router', () => {
  it.each(examples)('$condition with $query $headers', async (example) => {
    const url = new URL(`https://app.example.test/page${example.query ?? ''}`);
    const matched = anyConditionHolds([example.condition], url, new Headers(example.headers));

    expect(matched).toBe(await middlewareMatches(example, false));
    expect(!matched).toBe(await middlewareMatches(example, true));
  });
});
