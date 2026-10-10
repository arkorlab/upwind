/**
 * The app Function every route of an unsplit bundle is in, and the first of a split one.
 *
 * On its own, apart from the bundle's schema: a Function deciding whether a request is its own
 * reads it on every request (`placement.ts`), and the middleware's Function among them. Read off
 * `schema.ts`, it brought every schema of the bundle into that Function, built before its first
 * response — when the middleware's runtime is built without a schema at all.
 */
export const PRIMARY_FUNCTION = 'app';
