import { AuditError } from './dependencies.ts';
import type { Node } from './lexical-scope.ts';
import type { Visit } from './node-manifest-consumer-ast.ts';
import type {
  NodeManifestTurbopackCacheInitializer,
  NodeManifestTurbopackModuleId,
  NodeManifestTurbopackProjection,
} from './node-manifest-turbopack.ts';

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack cache initializer ${reason}; refusing native publication`,
  );
}

/** A registry of ordinary same-factory writes, never a registry of invocable factories. */
export class TurbopackCacheInitializers {
  private readonly body: Node;
  private readonly parents: ReadonlyMap<Node, Visit>;
  private readonly entries = new Map<
    NodeManifestTurbopackModuleId,
    NodeManifestTurbopackCacheInitializer
  >();

  constructor(body: Node, parents: ReadonlyMap<Node, Visit>) {
    this.body = body;
    this.parents = parents;
  }

  add(id: NodeManifestTurbopackModuleId, call: Node): void {
    const parent = this.parents.get(call)?.parent;
    if (parent?.type !== 'ExpressionStatement' || this.parents.get(parent)?.parent !== this.body)
      refuse('is not an unconditional top-level write');
    if (this.entries.has(id)) refuse('has multiple writes');
    this.entries.set(id, Object.freeze({ id, start: call.start, end: call.end }));
  }

  ownsWrite(id: NodeManifestTurbopackModuleId, call: Node): boolean {
    const entry = this.entries.get(id);
    return entry?.start === call.start && entry.end === call.end;
  }

  reads(id: NodeManifestTurbopackModuleId, call: Node): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined) return false;
    const parent = this.parents.get(call)?.parent;
    const statement =
      parent?.type === 'VariableDeclarator' && parent['init'] === call
        ? this.parents.get(parent)?.parent
        : parent;
    if (
      (statement?.type !== 'VariableDeclaration' && statement?.type !== 'ExpressionStatement') ||
      this.parents.get(statement)?.parent !== this.body ||
      call.start <= entry.end
    )
      refuse('read is not immediate and after its same-factory write');
    return true;
  }

  snapshot(): readonly NodeManifestTurbopackCacheInitializer[] {
    return Object.freeze(
      [...this.entries.values()].toSorted((left, right) => left.start - right.start),
    );
  }
}

/** Every internal ID has one original factory owner across the complete closed runtime table. */
export function assertTurbopackCacheOwners(
  records: readonly {
    readonly physical: { readonly id: string };
    readonly projection: NodeManifestTurbopackProjection;
  }[],
  registered: ReadonlySet<NodeManifestTurbopackModuleId>,
): void {
  const owners = new Map<NodeManifestTurbopackModuleId, string>();
  for (const record of records) {
    const projection = record.projection;
    const owner = [
      record.physical.id,
      projection.original.sha256,
      projection.factory.start,
      projection.factory.end,
    ];
    for (const entry of projection.cacheInitializers) {
      if (registered.has(entry.id)) refuse('collides with a registered module ID');
      const identity = JSON.stringify([...owner, entry.start, entry.end]);
      const previous = owners.get(entry.id);
      if (previous !== undefined && previous !== identity)
        refuse('has more than one original owner');
      owners.set(entry.id, identity);
    }
  }
}
