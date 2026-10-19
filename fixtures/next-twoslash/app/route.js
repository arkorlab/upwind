import { createTwoslasher } from 'twoslash';
import ts from 'typescript';

/** A fixed diagnostic category, never the exception's message, filename, stack or source. */
function errorCategory(error) {
  if (error?.code === 'MODULE_NOT_FOUND') return 'module-not-found';
  if (typeof error?.message === 'string' && error.message.startsWith('TSVFS: A request was made')) {
    return 'missing-library';
  }
  return 'other';
}

/** The computation and returned JSON of Next.js 16.4.2's official Twoslash fixture. */
export function GET(request) {
  try {
    const options = request.nextUrl.searchParams.has('esnext')
      ? {
          target: ts.ScriptTarget.ESNext,
          lib: ['ESNext', 'DOM', 'esnext', 'dom', 'es2020'],
        }
      : {};
    const code = `type X = Promise<number>;
'hello'.toUpperCase()`;
    const twoslasher = createTwoslasher({ compilerOptions: options });
    const response = Response.json(twoslasher(code));
    response.headers.set('x-upwind-twoslash-stage', 'handler-complete');
    return response;
  } catch (error) {
    const response = Response.json({ error });
    response.headers.set('x-upwind-twoslash-stage', 'handler-error');
    response.headers.set('x-upwind-twoslash-error', errorCategory(error));
    for (const key of ['name', 'code']) {
      const value = error?.[key];
      if (typeof value === 'string' && /^[\w.-]{1,64}$/.test(value)) {
        response.headers.set(`x-upwind-twoslash-error-${key}`, value);
      }
    }
    return response;
  }
}
