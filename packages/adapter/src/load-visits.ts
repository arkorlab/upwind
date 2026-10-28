import type { Node } from '@oxc-project/types';

/** A node on the way down: the visit it is under, by which field, and the statement it is in. */
export interface Visit {
  readonly node: Node;
  readonly up: Visit | undefined;
  readonly key: string | undefined;
  readonly statement: Node;
}

export function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value;
}

export function isStatement(node: Node): boolean {
  return node.type.endsWith('Statement') || node.type.endsWith('Declaration');
}

export function pushChildren(visit: Visit, pending: Visit[]): void {
  const { node } = visit;
  const statement = isStatement(node) ? node : visit.statement;
  for (const [key, value] of Object.entries(node)) {
    // A parent link, when the parser adds one, would lead back up.
    if (key === 'parent') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          pending.push({ node: item, up: visit, key, statement });
        }
      }
    } else if (isNode(value)) {
      pending.push({ node: value, up: visit, key, statement });
    }
  }
}

/** A use of the loader the bundler could not follow, in the module that makes it. */
export interface DynamicLoad {
  readonly file: string;
  /**
   * The line of the use in the module as Rolldown rendered it into the chunk — its statements
   * as Rolldown printed them, which is not the file's own layout.
   */
  readonly line: number;
  /** The call, or the assignment or statement that keeps the loader. */
  readonly text: string;
  /** Whether the code handles the load's failure itself (see above). */
  readonly guarded: boolean;
}

/**
 * As much of a use as the record shows: enough for the whole of the longest statement the audit
 * reads to the end, the require hook's resolver (`isRequireHookResolver`, in `dependencies.ts`),
 * whose 91 characters 80 cut inside `require.resolve`, where it reads as `require` kept.
 */
const DYNAMIC_LOAD_TEXT = 100;

/** A use as the record takes it: where it is, and as much of the text as the record shows. */
export function describeDynamicLoad(
  file: string,
  code: string,
  use: { readonly node: Node; readonly text: Node; readonly guarded: boolean },
): DynamicLoad {
  const { start } = use.text;
  return {
    file,
    line: code.slice(0, use.node.start).split('\n').length,
    text: code.slice(start, Math.min(use.text.end, start + DYNAMIC_LOAD_TEXT)),
    guarded: use.guarded,
  };
}
