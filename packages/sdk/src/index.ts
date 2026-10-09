/**
 * What an application reads its own storage through.
 *
 * Two ways in, and they answer different questions. This module is the one that takes names —
 * `d1('ORDERS')`, `kv('SESSIONS')`, `blob('UPLOADS')` — and is what a project with several of a kind
 * uses. The subpaths are the ones that take none: `@stayingupwind/sdk/db`, `/kv`, `/blob` and `/durable-object` each
 * default-export the one of its kind, which is all a project with one of each ever needs.
 *
 * Nothing here is configured, and nothing here can be. What is reachable is what the deployment
 * published, under the names it published them as; `published()` is how to see that list.
 */

export { blob, d1, durableObject, kv } from './named.ts';
export { published, type Published, type PublishedResource } from './published.ts';
