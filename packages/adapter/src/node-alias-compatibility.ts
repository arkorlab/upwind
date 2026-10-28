import path from 'node:path';

import { AuditError } from './dependencies.ts';

interface Link {
  readonly alias: string;
  readonly target: string;
}
interface Branch {
  readonly children: Map<string, Branch>;
  link: Link | undefined;
}

function branch(): Branch {
  return { children: new Map(), link: undefined };
}

function compatible(ancestor: Link, descendant: Link): boolean {
  const relative = path.posix.relative(ancestor.alias, descendant.alias);
  return path.posix.join(ancestor.target, relative) === descendant.target;
}

/** Index only archive layout links; no resolution, source closure or executable authority. */
export class NodeAliasCompatibility {
  private readonly root = branch();

  constructor(links: ReadonlyMap<string, string> = new Map()) {
    for (const [alias, target] of links) {
      if (!this.accepts(alias, target))
        throw new AuditError(
          'Node artifact required aliases have incompatible topology; refusing publication',
        );
      this.add(alias, target);
    }
  }

  add(alias: string, target: string): void {
    let current = this.root;
    for (const part of alias.split('/')) {
      let next = current.children.get(part);
      if (next === undefined) {
        next = branch();
        current.children.set(part, next);
      }
      current = next;
    }
    current.link = { alias, target };
  }

  accepts(alias: string, target: string): boolean {
    const candidate = { alias, target };
    let current: Branch | undefined = this.root;
    for (const part of alias.split('/')) {
      if (current.link !== undefined && !compatible(current.link, candidate)) return false;
      current = current.children.get(part);
      if (current === undefined) return true;
    }
    // Includes the exact path and every existing descendant that emittedLinks might hide.
    const pending = [current];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (next.link !== undefined && !compatible(candidate, next.link)) return false;
      for (const child of next.children.values()) pending.push(child);
    }
    return true;
  }
}
