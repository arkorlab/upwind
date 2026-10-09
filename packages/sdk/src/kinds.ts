/**
 * The four kinds of storage, and the words each one is described with.
 *
 * Here because one implementation decides all four: how a bare accessor resolves, and what it says
 * when it cannot. A message that names the wrong thing is worse than no message, so the naming is
 * data rather than something each entry point writes out for itself.
 */
export interface Kind {
  /** The type a deployment lists this kind under. What the count is taken over. */
  readonly type: string;
  /** What a person calls one of them. Two of them is this and an `s`. */
  readonly called: string;
  /** What the accessor for it is called where it is exported, so a message can name it. */
  readonly accessor: string;
  /** The function that takes a name, for the message that has to suggest naming one. */
  readonly lookup: string;
  /** Where both of those come from. */
  readonly module: string;
}

export const D1: Kind = {
  type: 'd1',
  called: 'D1 database',
  accessor: 'db',
  lookup: 'd1',
  module: '@stayingupwind/sdk/db',
};

export const KV: Kind = {
  type: 'kv_namespace',
  called: 'KV namespace',
  accessor: 'kv',
  lookup: 'kv',
  module: '@stayingupwind/sdk/kv',
};

export const BLOB: Kind = {
  type: 'r2_bucket',
  called: 'R2 bucket',
  accessor: 'blob',
  lookup: 'blob',
  module: '@stayingupwind/sdk/blob',
};

export const DURABLE_OBJECT: Kind = {
  type: 'durable_object_namespace',
  called: 'Durable Object namespace',
  accessor: 'durableObject',
  lookup: 'durableObject',
  module: '@stayingupwind/sdk/durable-object',
};
