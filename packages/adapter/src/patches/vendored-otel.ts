/**
 * `@opentelemetry/api` for an app that does not carry its own.
 *
 * Next.js requires it and, when the require throws, falls back to the copy it ships
 * (`next/dist/server/lib/trace/tracer.js`). A bundler has no try/catch: Rolldown cannot resolve a
 * package that is not installed, leaves the specifier external with a warning, and a Function has
 * no resolver to satisfy it at run time — so the audit refuses the build. Every app without
 * OpenTelemetry installed hits this, which is every app that is not already using it.
 *
 * Resolving to the copy Next.js would itself have fallen back to keeps that behaviour and leaves
 * an app that does carry its own untouched: it is preferred, exactly as Next.js prefers it. The
 * vendored copy exports what the tracer destructures, which is the whole of what Next.js uses.
 */

export const OTEL_API = '@opentelemetry/api';
export const VENDORED_OTEL_API = 'next/dist/compiled/@opentelemetry/api';
