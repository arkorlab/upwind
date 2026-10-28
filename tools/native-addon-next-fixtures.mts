/**
 * The fixed official native-addon fixtures `native-addon-next-ci.mts` builds: each one's pinned
 * upstream files, what its build needs besides them, and how its running Function is checked.
 */
import assert from 'node:assert/strict';
import path from 'node:path';

import type { NativeFixtureIdentity } from './native-addon-next-artifact.mts';

const HTTP_MISDIRECTED = 421;
/** This tool's own App Router page, rendered for each request. */
const REQUEST_PATH = '/native-request';

/** The running Function, as a smoke reaches it: by public path, through its control headers. */
export interface FixtureClient {
  readonly request: (
    pathname: string,
    headers?: Readonly<Record<string, string>>,
  ) => Promise<Response>;
  /** A successful response's bounded text; any other status fails the control. */
  readonly body: (response: Response) => Promise<string>;
}

export interface Fixture {
  /** Every file of the upstream directory, by its Git blob. */
  readonly pinned: Readonly<Record<string, string>>;
  /** Pinned files the build leaves out, such as a suite's own test file beside its app. */
  readonly excluded: readonly string[];
  /** Packages the build needs beyond Next.js and React, at exact versions. */
  readonly dependencies: Readonly<Record<string, string>>;
  /** This tool's own files beside the fixture's, by path: never pinned, never upstream. */
  readonly added: Readonly<Record<string, string>>;
  /** Checks the running Function, and names the paths it checked. */
  readonly smoke: (
    identity: NativeFixtureIdentity,
    client: FixtureClient,
  ) => Promise<readonly string[]>;
}

export function record(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'Expected a JSON object',
  );
  return value as Record<string, unknown>;
}

function nextData(html: string): Record<string, unknown> {
  const start = html.indexOf('<script id="__NEXT_DATA__"');
  assert.ok(start !== -1, 'Missing Next data script');
  const content = html.indexOf('>', start);
  const end = html.indexOf('</script>', content);
  assert.ok(content !== -1 && end !== -1, 'Malformed Next data script');
  return record(JSON.parse(html.slice(content + 1, end)));
}

interface PageProperties {
  readonly params: { readonly slug: string };
  readonly blog: true;
  readonly contextAware: true;
  readonly users: readonly {
    readonly id: number;
    readonly first_name: string;
    readonly last_name: string;
  }[];
}

function expected(slug: string): PageProperties {
  return {
    params: { slug },
    blog: true,
    contextAware: true,
    users: [
      { id: 1, first_name: 'john', last_name: 'deux' },
      { id: 2, first_name: 'zeit', last_name: 'geist' },
    ],
  };
}

async function pagesSmoke(
  identity: NativeFixtureIdentity,
  { request, body: bodyOf }: FixtureClient,
): Promise<readonly string[]> {
  const firstResponse = await request('/blog/first');
  const first = nextData(await bodyOf(firstResponse));
  assert.deepEqual(record(first['props'])['pageProps'], expected('first'));
  // Browser fallback fetches this exact Pages data route after receiving its initial shell.
  await bodyOf(await request('/blog/second'));
  const secondResponse = await request(
    `/_next/data/${encodeURIComponent(identity.buildId)}/blog/second.json`,
    { 'x-nextjs-data': '1' },
  );
  const secondJson: unknown = JSON.parse(await bodyOf(secondResponse));
  const second = record(secondJson);
  assert.deepEqual(second['pageProps'], expected('second'));
  return ['/blog/first', '/blog/second'];
}

/**
 * This tool's page beside the App Router fixture, whose own pages are prerendered at build: one
 * rendered for each request, so the addon is shown to load when a request comes.
 */
const REQUEST_PAGE = [
  "import nativeAddon from 'native-addon'",
  "export const dynamic = 'force-dynamic'",
  'export default function Page() {',
  '  return <p id="request">{String(nativeAddon.CONTEXT_AWARE) + \' \' + String(performance.now())}</p>',
  '}',
  '',
].join('\n');

function requested(html: string): { readonly contextAware: string; readonly at: string } {
  const found = /<p id="request">(\w+) ([\d.]+)<\/p>/u.exec(html);
  assert.ok(found?.[1] !== undefined && found[2] !== undefined, 'Missing the per-request page');
  return { contextAware: found[1], at: found[2] };
}

async function appRouterSmoke(
  _identity: NativeFixtureIdentity,
  { request, body: bodyOf }: FixtureClient,
): Promise<readonly string[]> {
  const page = await bodyOf(await request('/native-addon-import-5913'));
  assert.ok(page.includes('<h1 id="message">Hello World</h1>'), 'The native page did not render');
  assert.ok(page.includes('<p id="context-aware">true</p>'), 'The native page lost its addon');
  const first = requested(await bodyOf(await request(REQUEST_PATH)));
  const second = requested(await bodyOf(await request(REQUEST_PATH)));
  assert.deepEqual([first.contextAware, second.contextAware], ['true', 'true']);
  assert.notEqual(first.at, second.at, 'The per-request page was not rendered for each request');
  const flight = await request(REQUEST_PATH, { RSC: '1' });
  assert.equal(flight.headers.get('content-type'), 'text/x-component');
  await bodyOf(flight);
  // A route no native load owns stays on its Worker; the Container refuses to answer for it.
  const worker = await request('/');
  await worker.body?.cancel();
  assert.equal(worker.status, HTTP_MISDIRECTED, 'The Container answered a Worker route');
  return ['/native-addon-import-5913', REQUEST_PATH];
}

const FIXTURES: Readonly<Record<string, Fixture>> = {
  'prerender-native-module': {
    pinned: {
      '.npmrc': '951a2b6e795f12e7e5e47a7ce71ab649cbb6e614',
      'bindings/index.js': 'fd4a2e414af0b19ae18ef43baed3eaa37a918db5',
      'bindings/package.json': 'a942bce5029cb83ffbf14d56d1d871ade3eba2e5',
      'native-addon-wrapper/index.js': '3c4a1356340798dd8f18b0e03fffdc4f3e99a1df',
      'native-addon-wrapper/package.json': 'be8bcc6a8708932ecdccd4e9b1484f0711656b3d',
      'native-addon/addon.cc': '2436d072feb14ad567e0abfe4309d2a02ac7b837',
      'native-addon/binding.gyp': '9c111067225943ff066f9a7b12d1891a642d3ca0',
      'native-addon/index.js': '52a1e8bf48a95cede2d325c2540aa6e679450339',
      'native-addon/package.json': '37c6888cf9a97330eb2f19c6c2679b8a36d8d679',
      'package.json': '22e1cf3cb2033b62c0e13cb70bdf4dca04874943',
      'pages/blog/[slug].js': 'fc0337f79e7b1aee3da96da05fd4c3116e7911c5',
      'pages/index.js': '39a9c6502ed04e370cf4f31db959c35874bceaa9',
      'pnpm-workspace.yaml': '68e8462f659082028ecf628c03a4b6f7bc32ae8a',
      'users.json': 'f683b73c83219124be7ca5d5c27d0bf4aa62afd2',
    },
    excluded: [],
    dependencies: {},
    added: {},
    smoke: pagesSmoke,
  },
  'turbopack-reports': {
    pinned: {
      '.npmrc': '951a2b6e795f12e7e5e47a7ce71ab649cbb6e614',
      'app/layout.tsx': 'e7077399c03ce1479a655dc647c0545b64531628',
      'app/native-addon-import-5913/page.tsx': 'f0ca00a0b554998d6e7465a4f41b0917f6edd5f8',
      'app/page.tsx': 'ff7159d9149feeb1eb8f4b7bbeadb2e26c20b053',
      'bindings/index.js': 'fd4a2e414af0b19ae18ef43baed3eaa37a918db5',
      'bindings/package.json': 'a942bce5029cb83ffbf14d56d1d871ade3eba2e5',
      'native-addon/addon.cc': '2436d072feb14ad567e0abfe4309d2a02ac7b837',
      'native-addon/binding.gyp': '9c111067225943ff066f9a7b12d1891a642d3ca0',
      'native-addon/index.js': '52a1e8bf48a95cede2d325c2540aa6e679450339',
      'native-addon/package.json': '37c6888cf9a97330eb2f19c6c2679b8a36d8d679',
      'next.config.js': 'b3e90b5c754141f4822d9f88f22053716fa4d37e',
      'package.json': '6119493942442780a859531de40a31214aeba90d',
      'pnpm-workspace.yaml': '68e8462f659082028ecf628c03a4b6f7bc32ae8a',
      'turbopack-reports.test.ts': '513ff1f5c5382943b4a670058b08fdccec56af95',
    },
    // The suite's own test sits beside the app; Next.js's type check would read its Jest globals.
    excluded: ['turbopack-reports.test.ts'],
    // A TypeScript app under `CI=true` is not given these by Next.js; the SDK's own pins.
    dependencies: { typescript: '6.0.3', '@types/node': '24.19.2', '@types/react': '19.2.2' },
    added: { 'app/native-request/page.tsx': REQUEST_PAGE },
    smoke: appRouterSmoke,
  },
};

export function fixtureOf(source: string): Fixture {
  const fixture = FIXTURES[path.basename(source)];
  assert.ok(fixture !== undefined, `Not a fixed native fixture: ${path.basename(source)}`);
  return fixture;
}
