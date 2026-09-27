import type { D1Database } from '@cloudflare/workers-types';

import { D1 } from './kinds.ts';
import { sole } from './sole.ts';

export { d1 } from './named.ts';

/**
 * The project's database.
 *
 * ```ts
 * import db from '@stayingupwind/sdk/db';
 *
 * const { n } = (await db.prepare('select 1 as n').first()) ?? {};
 * ```
 *
 * Whichever D1 database this deployment published, as long as it published exactly one — and it says
 * so rather than guessing when that is not true (`sole.ts`). A project with two of them names the one
 * it means with `d1`, which is here as well so that the message and the way out of it are one import
 * apart.
 *
 * The default export, because a module whose subject is one thing should not make a reader say that
 * thing twice.
 */
const db = sole(D1) as D1Database;

export default db;
