/**
 * The deployment's storage bindings, as the SDK reads them: published by the runtime at
 * `globalThis[Symbol.for('upwind.resources')]`. The fixture reads the symbol itself, so it needs
 * no SDK of its own.
 */

export interface Kv {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
}

export interface Bucket {
  get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
  put: (key: string, value: string) => Promise<unknown>;
}

export interface Database {
  prepare: (query: string) => { first: <T>() => Promise<T | null> };
}

interface Published {
  readonly version: number;
  readonly resources: Readonly<
    Record<string, { readonly type: string; readonly binding: unknown }>
  >;
}

export function published(): Published | undefined {
  return (globalThis as Record<symbol, unknown>)[Symbol.for('upwind.resources')] as
    | Published
    | undefined;
}

/** A binding by its name, when it is of the kind asked for. */
function binding(name: string, type: string): unknown {
  const entry = published()?.resources[name];
  return entry?.type === type ? entry.binding : undefined;
}

export function kv(name: string): Kv | undefined {
  return binding(name, 'kv_namespace') as Kv | undefined;
}

export function bucket(name: string): Bucket | undefined {
  return binding(name, 'r2_bucket') as Bucket | undefined;
}

export function database(name: string): Database | undefined {
  return binding(name, 'd1') as Database | undefined;
}
