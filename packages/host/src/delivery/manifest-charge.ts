import type { ProjectManifest } from '@stayingupwind/core/manifest';

const KIB = 1024;
const MIB = KIB * KIB;

/**
 * What an edge isolate holds shells, delivery records and manifests within, and so the most one
 * manifest may be charged (`manifestCharge`). With the pointers, the member ids and the caches
 * bounded by count, each full, everything an isolate holds comes to about 70 MiB of its 128 MB, as
 * measured: the rest is the runtime's own, and the bodies in flight. Here rather than in the edge
 * alone, because a deployment is refused a manifest past it (`oversizedManifest`,
 * `@stayingupwind/deploy/manifest`): an isolate would hold none of it, and the deployment's every
 * request would be passed through without it, its `_next/` files among them.
 */
const EDGE_ISOLATE_BUDGET_MIB = 40;
export const EDGE_ISOLATE_BUDGET_BYTES = EDGE_ISOLATE_BUDGET_MIB * MIB;

/**
 * A manifest is measured by the UTF-8 bytes of the JSON it was parsed from, and takes more held
 * parsed — how much more turns on how many objects it is made of rather than on its bytes, since
 * each is a header, keys and a table of slots whatever it holds. As measured: 1.4 to 1.6 times its
 * JSON when it lists routes and files, 2.5 to 3.5 for tens of thousands of rules, 6.8 for two
 * hundred thousand exact pathnames of four characters. So a manifest is charged 1.5 times its JSON
 * and 80 bytes for each of its entries — a route, a file, a pathname — and for each object of each
 * rule, which is more than every one of those took.
 */
const MANIFEST_JSON_FACTOR = 1.5;
const MANIFEST_OBJECT_BYTES = 80;
/**
 * Each pathname a split deployment names an app Function for (`exactFunctions`) is charged 48 bytes
 * beside its JSON. It is a pathname `exactPathnames` lists as well (`withFunctions`,
 * `@stayingupwind/core/bundle`), which both tables key on as one string once parsed, and the name
 * it maps to is one of a few every entry shares, so what an entry adds is its share of a table of
 * its own, which doubles as it fills. As measured in Node 24 with the JSON held parsed, for
 * pathnames of four characters each named a Function, that came to 63 bytes an entry at two
 * hundred thousand of them — 30.0 MB held, charged 24.6 MB without these — and to 72, the most, at
 * 174,800, just after the table grew: 29.4 MB held, charged 21.4 MB. An entry's JSON, 16 bytes
 * charged one and a half times, comes to 24 of those 72, and 48 covers the rest. At 80, as for an
 * entry of its own, each would be charged 104 bytes, more than any took, and a manifest of such
 * pathnames refused past some 207 thousand of them rather than 245 thousand.
 */
// Gate names and gated pathname routes are strings too, so their lookup tables take the same
// additional per-entry charge. Their JSON still pays for the strings; no per-entry object is made.
const PATHNAME_TABLE_BYTES = 48;

/** A rule as a manifest lists one: a pattern, and perhaps conditions and headers. */
interface RuleObjects {
  readonly has?: readonly unknown[] | undefined;
  readonly missing?: readonly unknown[] | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly documentHeaders?: Readonly<Record<string, string>> | undefined;
  readonly documentRecoverySources?: Readonly<Record<string, string>> | undefined;
  readonly members?:
    | {
        readonly bypassFor?: readonly unknown[] | undefined;
        readonly keyedBy?: readonly unknown[] | undefined;
      }
    | undefined;
}

function keysOf(record: Readonly<Record<string, unknown>> | undefined): number {
  if (record === undefined) {
    return 0;
  }
  return Object.keys(record).length;
}

/** A list and what is in it. */
function listObjects(list: readonly unknown[] | undefined): number {
  return list === undefined ? 0 : 1 + list.length;
}

/** Rule-local containers, excluding the two collections whose physical identities may be shared. */
function ruleContainers(rule: RuleObjects): number {
  let objects = 1 + listObjects(rule.has) + listObjects(rule.missing);
  objects += (rule.headers === undefined ? 0 : 1) + (rule.documentHeaders === undefined ? 0 : 1);
  const members = rule.members;
  if (members !== undefined) {
    objects += 1 + (members.keyedBy === undefined ? 0 : 1);
  }
  return objects;
}

/** A recovery-source map is charged once across both header-rule lists. */
function recoveryObjects(
  sources: Readonly<Record<string, string>>,
  seen: WeakSet<Readonly<Record<string, string>>>,
): number {
  if (seen.has(sources)) {
    return 0;
  }
  seen.add(sources);
  return 1;
}

/** The objects rules are made of: each rule, its conditions and their lists, and its headers. */
function ruleObjects(
  rules: readonly RuleObjects[] | undefined,
  following?: readonly RuleObjects[],
): number {
  let objects = 0;
  let memberConditions: WeakSet<readonly unknown[]> | undefined;
  let recoveryMaps: WeakSet<Readonly<Record<string, string>>> | undefined;
  let list = rules ?? following;
  let next = rules === undefined ? undefined : following;
  while (list !== undefined) {
    for (const rule of list) {
      objects += ruleContainers(rule);
      const sources = rule.documentRecoverySources;
      if (sources !== undefined) {
        recoveryMaps ??= new WeakSet();
        objects += recoveryObjects(sources, recoveryMaps);
      }
      const conditions = rule.members?.bypassFor;
      if (conditions === undefined) {
        continue;
      }
      // Digest-vouched reads restore one table array for every member that shares it.
      memberConditions ??= new WeakSet();
      if (!memberConditions.has(conditions)) {
        memberConditions.add(conditions);
        objects += listObjects(conditions);
      }
    }
    list = next;
    next = undefined;
  }
  return objects;
}

/** The routes, files and pathnames a manifest lists, and the objects of its rules. */
function manifestObjects(manifest: ProjectManifest): number {
  const bodies = manifest.routeBodies;
  const bodyObjects =
    bodies === undefined
      ? 0
      : 1 +
        Object.values(bodies).reduce((count, entry) => count + 1 + listObjects(entry.bypassFor), 0);
  return (
    bodyObjects +
    keysOf(manifest.routes) +
    keysOf(manifest.staticFiles) +
    keysOf(manifest.exactPathnames) +
    keysOf(manifest.filesystemPages) +
    ruleObjects(manifest.dynamicRoutes) +
    ruleObjects(manifest.reservedRoutes) +
    ruleObjects(manifest.headerRules, manifest.foldedHeaderRules) +
    ruleObjects(manifest.middleware?.matchers)
  );
}

/**
 * What a manifest is charged: all of what it takes, however much. Whatever deploys refuses a
 * manifest past `MAX_MANIFEST_BYTES` of JSON, but not one of that size that lists hundreds of
 * thousands of short entries. Such a manifest may take the whole budget rather than half of it —
 * it is every route of a deployment, read by each of its requests, and one a large site publishes
 * honestly comes to more than half — and one past the whole budget is not held at all: its
 * deployment is passed through, as for a manifest that does not parse (`getManifest`). Charged
 * less than it takes, it was held as if it fit, and two of them could take the isolate's memory.
 */
export function manifestCharge(manifest: ProjectManifest, jsonBytes: number): number {
  return (
    MANIFEST_JSON_FACTOR * jsonBytes +
    MANIFEST_OBJECT_BYTES * manifestObjects(manifest) +
    PATHNAME_TABLE_BYTES *
      (keysOf(manifest.exactFunctions) + keysOf(manifest.gates) + keysOf(manifest.gatedPathnames))
  );
}
