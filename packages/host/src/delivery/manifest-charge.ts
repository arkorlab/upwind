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

/** A rule as a manifest lists one: a pattern, and perhaps conditions and headers. */
interface RuleObjects {
  readonly has?: readonly unknown[] | undefined;
  readonly missing?: readonly unknown[] | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly documentHeaders?: Readonly<Record<string, string>> | undefined;
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

/** The objects rules are made of: each rule, its conditions and their lists, and its headers. */
function ruleObjects(rules: readonly RuleObjects[] | undefined): number {
  if (rules === undefined) {
    return 0;
  }
  let objects = 0;
  for (const rule of rules) {
    objects += 1 + listObjects(rule.has) + listObjects(rule.missing);
    objects += (rule.headers === undefined ? 0 : 1) + (rule.documentHeaders === undefined ? 0 : 1);
  }
  return objects;
}

/** The routes, files and pathnames a manifest lists, and the objects of its rules. */
function manifestObjects(manifest: ProjectManifest): number {
  return (
    keysOf(manifest.routes) +
    keysOf(manifest.staticFiles) +
    keysOf(manifest.exactPathnames) +
    keysOf(manifest.filesystemPages) +
    ruleObjects(manifest.dynamicRoutes) +
    ruleObjects(manifest.reservedRoutes) +
    ruleObjects(manifest.headerRules) +
    ruleObjects(manifest.foldedHeaderRules) +
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
  return MANIFEST_JSON_FACTOR * jsonBytes + MANIFEST_OBJECT_BYTES * manifestObjects(manifest);
}
