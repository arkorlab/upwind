import type { Kind } from './kinds.ts';
import { type Published, type PublishedResource, read, unreadable } from './published.ts';

/**
 * The one of a kind, reached without naming it.
 *
 * The rule is the count, and only the count: where exactly one binding of a kind is published, that
 * is the one — whatever it is called. No name is matched and no name is special, which is what makes
 * the same rule answer for a project that was handed its storage without asking and for one that
 * declared a single database of its own under a name of its choosing. Anything else is refused out
 * loud: nothing to choose from, or more than one and no grounds to pick.
 */

/** A method as it is reached through the stand-in below; its receiver is what matters. */
type Method = (this: unknown, ...args: unknown[]) => unknown;

/** Cloudflare's object, as much as anything here needs to know about it: something with methods. */
type Reached = Record<string | symbol, unknown>;

/** Every binding of one kind, in the order they were published. */
function ofKind(published: Published, type: string): [string, PublishedResource][] {
  return Object.entries(published.resources).filter(([, resource]) => resource.type === type);
}

/** Nothing is published at all, which says something about the run rather than about the project. */
function nothingPublished(kind: Kind): string {
  return `\`${kind.accessor}\` found no storage published in this run, so there is no ${kind.called} to reach: \`upwind dev\` and \`upwind build\` publish a project's storage locally and a deployment's Function publishes its own, so running under a plain \`next dev\`, a plain \`next build\` or a test runner is the usual reason to be reading this`;
}

/** Storage is published and none of it is this kind — so this is about the project, not the run. */
function noneOfKind(kind: Kind, published: Published): string {
  const others = Object.entries(published.resources).map(
    ([name, resource]) => `${name} (${resource.type})`,
  );
  return `\`${kind.accessor}\` found no ${kind.called} among the storage published in this run, which is ${others.length === 0 ? 'empty' : others.join(', ')}`;
}

/** More than one. The count was the whole rule, so there is nothing left to decide with. */
function tooMany(kind: Kind, first: string, names: readonly string[]): string {
  return `\`${kind.accessor}\` found ${String(names.length)} ${kind.called}s published — ${names.join(', ')} — and will not choose between them: name the one you mean, \`${kind.lookup}('${first}')\` from '${kind.module}'`;
}

function soleOf(kind: Kind): unknown {
  const reading = read();
  if (reading.state === 'unreadable') {
    throw new Error(unreadable(reading.saw));
  }
  if (reading.state === 'absent') {
    throw new Error(nothingPublished(kind));
  }
  const found = ofKind(reading.published, kind.type);
  const [first, ...rest] = found;
  if (first === undefined) {
    throw new Error(noneOfKind(kind, reading.published));
  }
  if (rest.length > 0) {
    throw new Error(
      tooMany(
        kind,
        first[0],
        found.map(([name]) => name),
      ),
    );
  }
  return first[1].binding;
}

/**
 * A stand-in for the one binding of a kind, which resolves the first time it is reached.
 *
 * Not a value, because at the moment a module is evaluated there is nothing to be a value of: an
 * application's modules are evaluated before any request, and in a Function the environment its
 * bindings come from arrives with the first one. Resolving on use also puts the failure where it can
 * be read — at the line that wanted a database, not at an import that says nothing about why.
 *
 * Only `get` and `has` are answered. This is for reaching what the storage can do; a question *about*
 * the storage — what is published, under what names — is `published()`'s to answer, and asking it of
 * a stand-in would get an answer about the stand-in.
 */
export function sole(kind: Kind): unknown {
  let resolved: Reached | undefined;
  const reach = (): Reached => (resolved ??= soleOf(kind) as Reached);
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        const on = reach();
        const value: unknown = Reflect.get(on, property, on);
        // Bound to what it came from: these are Cloudflare's own objects, and their methods are
        // methods — `db.prepare(…)` reached through a stand-in would otherwise lose its receiver.
        return typeof value === 'function' ? (value as Method).bind(on) : value;
      },
      has: (_target, property) => Reflect.has(reach(), property),
    },
  );
}
