import type { FunctionModuleType } from '@stayingupwind/core/bundle';

/**
 * A Worker as Cloudflare's upload takes it: a multipart form with one part of JSON — the
 * `metadata`, which names the main module and says everything else about the Worker — and one part
 * per module, each under its own name and with a content type that says what kind of module it is.
 *
 * The content type is the module's kind. An ES module and a CommonJS one are both JavaScript to a
 * browser and two different things to the runtime, which reads `application/javascript+module` as
 * the one and `application/javascript` as the other; text, JSON, data and WebAssembly each have
 * theirs.
 */

/** What the runtime reads a module part's content type as. */
export const MODULE_CONTENT_TYPES: Readonly<Record<FunctionModuleType, string>> = {
  esm: 'application/javascript+module',
  commonjs: 'application/javascript',
  text: 'text/plain',
  json: 'application/json',
  wasm: 'application/wasm',
  data: 'application/octet-stream',
};

/** The form part the configuration travels in, which no module may be called. */
export const METADATA_PART = 'metadata';

/** One module of a Worker, as its bytes. */
export interface ModulePart {
  readonly name: string;
  readonly type: FunctionModuleType;
  readonly bytes: Uint8Array;
}

/** A binding as the upload's metadata gives it: its kind, its name, and what that kind needs. */
export type WorkerBinding =
  | { readonly type: 'plain_text'; readonly name: string; readonly text: string }
  | { readonly type: 'secret_text'; readonly name: string; readonly text: string }
  | { readonly type: 'json'; readonly name: string; readonly json: unknown }
  | {
      readonly type: 'service';
      readonly name: string;
      readonly service: string;
      readonly entrypoint?: string;
      readonly props?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: 'kv_namespace'; readonly name: string; readonly namespace_id: string }
  | { readonly type: 'r2_bucket'; readonly name: string; readonly bucket_name: string }
  // `id`, not the reference's `database_id`: what the upload is sent by every tool that sends one.
  | { readonly type: 'd1'; readonly name: string; readonly id: string }
  | {
      readonly type: 'durable_object_namespace';
      readonly name: string;
      readonly class_name: string;
    }
  | { readonly type: 'version_metadata'; readonly name: string }
  | { readonly type: 'images'; readonly name: string }
  | { readonly type: 'inherit'; readonly name: string };

/** A migration of the Durable Objects a Worker implements, as the upload's metadata gives one. */
export interface WorkerMigrations {
  readonly new_tag: string;
  readonly old_tag?: string;
  readonly steps: readonly { readonly new_sqlite_classes?: readonly string[] }[];
}

/** What the upload says about a Worker beside its modules. */
export interface WorkerMetadata {
  readonly main_module: string;
  readonly compatibility_date: string;
  readonly compatibility_flags?: readonly string[];
  readonly bindings: readonly WorkerBinding[];
  readonly annotations?: Readonly<Record<string, string>>;
  /** Binding kinds an update keeps as they are, unnamed: a secret this run never knew stays. */
  readonly keep_bindings?: readonly string[];
  readonly migrations?: WorkerMigrations;
  readonly observability?: Readonly<Record<string, unknown>>;
  readonly logpush?: boolean;
  readonly tags?: readonly string[];
}

/**
 * The form an upload sends. Refuses a module called `metadata`, which would be read as the
 * configuration — and refuses it here, where a module's name first meets the configuration's.
 */
export function workerForm(metadata: WorkerMetadata, modules: readonly ModulePart[]): FormData {
  const form = new FormData();
  form.set(METADATA_PART, new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  const named = new Set<string>();
  for (const module of modules) {
    if (module.name === METADATA_PART) {
      throw new Error(
        `a module called \`${METADATA_PART}\` would be read as the Worker's configuration`,
      );
    }
    if (named.has(module.name)) {
      throw new Error(`two modules are called ${module.name}`);
    }
    named.add(module.name);
    form.set(
      module.name,
      new Blob([module.bytes as Uint8Array<ArrayBuffer>], {
        type: MODULE_CONTENT_TYPES[module.type],
      }),
      module.name,
    );
  }
  if (!named.has(metadata.main_module)) {
    throw new Error(`the main module ${metadata.main_module} is not among the modules`);
  }
  return form;
}
