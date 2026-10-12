/**
 * What `pnpm check:vocabulary` looks for, and what it lets through: a list of its own, so that a
 * change to it is read as one. A term says why it is out, and carries the words it must find and the
 * words it must pass over, which the check tries before it reads anything (`selfCheck`).
 */

export interface Term {
  readonly id: string;
  /**
   * Global, so every occurrence in a file is counted. Words are apart by ` +`, or by `_` and a space
   * in an identifier, and a term ends where no letter or digit follows, an identifier's `_` among
   * what may: a file is searched as `searchable` reads it.
   */
  readonly pattern: RegExp;
  readonly why: string;
  /** What the pattern must find, and what it must not: tried before anything is read. */
  readonly finds: readonly string[];
  readonly passes: readonly string[];
}

export const TERMS: readonly Term[] = [
  {
    id: 'resource-name',
    pattern: /\bppr[-_]/giu,
    why: 'a name nothing here is given: say what the thing is or does',
    finds: [
      'ppr-example',
      'a ppr_example table',
      'ppr-shells',
      'ppr-shell-cache',
      'example-ppr-shell',
      'example_ppr-shell',
    ],
    passes: ['upper-bound', 'appr-', "kind: 'ppr-shell'"],
  },
  {
    id: 'host-name',
    pattern: /\barkor(?![\da-z])/giu,
    why: 'a host by name: these packages serve a deployment on whichever host runs them, and keep only the identifiers upwind ships',
    finds: ['Arkor', 'www.arkor.example', 'an arkor.example hostname'],
    passes: [
      'x-arkor-edge',
      'ARKOR_CACHE',
      '.arkor/bundle.json',
      'arkor:cache-host',
      'darkorange',
      'Copyright 2026 Arkor and Contributors',
    ],
  },
  {
    id: 'control-plane',
    pattern: /\bcontrol(?:-|_? +)plane(?![\da-z])/giu,
    why: 'whatever publishes a deployment is the host, and these packages do not name its parts',
    finds: [
      'the control plane',
      'control-plane',
      'the control\nplane',
      'the control\n * plane',
      'controlPlane',
      'isControlPlaneRequest',
      'control_plane',
      'CONTROL_PLANE',
    ],
    passes: ['controls the plane', 'control\n\nplane'],
  },
  {
    id: 'dispatch-namespace',
    pattern: /\bdispatch(?:-|_? +)namespaces?(?![\da-z])/giu,
    why: 'a deployment reaches its Functions through the bindings it is given, whatever a host runs them in',
    finds: [
      'dispatch namespace',
      'dispatch namespaces',
      'dispatch\n  // namespace',
      'dispatchNamespace',
      'DISPATCH_NAMESPACE',
    ],
    passes: ['dispatch to a namespace'],
  },
  {
    id: 'workers-for-platforms',
    pattern: /\bworkers(?:-|_? +)for(?:-|_? +)platforms(?![\da-z])/giu,
    why: 'a deployment reaches its Functions through the bindings it is given, whatever a host runs them in',
    finds: [
      'Workers for Platforms',
      'Workers for\r\nPlatforms',
      'workersForPlatforms',
      'WORKERS_FOR_PLATFORMS',
      'workers-for-platforms',
    ],
    passes: ['workers for a platform'],
  },
  {
    id: 'validation-namespace',
    pattern: /\bvalidation(?:-|_? +)namespaces?(?![\da-z])/giu,
    why: "how a host proves a deployment before it goes live is the host's own",
    finds: [
      'the validation namespace',
      'the validation\n# namespace',
      'validationNamespaces',
      'validation-namespace',
    ],
    passes: ['validation of a namespace'],
  },
  {
    id: 'analytics-engine',
    pattern: /\banalytics(?:-|_? +)engine(?![\da-z])/giu,
    why: "where a host records what it measures is the host's own: these packages report to what they are given",
    finds: [
      'Analytics Engine',
      'Analytics\n> Engine',
      'analyticsEngine',
      'ANALYTICS_ENGINE',
      'analytics-engine',
    ],
    passes: ['analytics, an engine'],
  },
  {
    id: 'storage-region',
    pattern: /\b(?:wnam|enam|weur|eeur|apac)(?![\da-z])/giu,
    why: "where storage is placed is the host's to choose (a location hint it passes in), not a region these packages name",
    finds: ['weur', "locationHint: 'apac'", 'isEnam', 'EEUR_HINT'],
    passes: ['locationHint', 'apache', 'wnamed'],
  },
  {
    id: 'tenancy',
    pattern: /tenan(?:cy|t)/giu,
    why: "a deployment these packages serve is one site; whose it is, is the host's business",
    finds: ['tenant', 'tenantId', 'multi-tenancy'],
    passes: ['tenable'],
  },
  {
    id: 'dashboard',
    pattern: /dashboard/giu,
    why: "a host's own interface",
    finds: ['the dashboard', 'Dashboard'],
    passes: ['dash board'],
  },
  {
    id: 'billing',
    pattern: /billing/giu,
    why: 'what a host charges for',
    finds: ['billing', 'billingEvent'],
    passes: ['billion'],
  },
  {
    id: 'inspector',
    pattern: /\binspector(?![\da-z])/giu,
    why: "a host's own view of a deployment's cache",
    finds: ['the inspector', 'an Inspector', 'cacheInspector', 'inspector_link'],
    passes: ['inspectors', 'inspect it'],
  },
  {
    id: 'repository-path',
    pattern: /\bapps\//gu,
    why: "a path in another repository's tree, which these packages do not see",
    finds: ['apps/example/src', '(apps/example)'],
    passes: ['webapps/', 'Apps/'],
  },
  {
    id: 'readme-reference',
    pattern: /\(README, +"/gu,
    why: "a section of another repository's README: cite this repository's by its path",
    finds: ['(README, "Caching")', '(README,\n * "Caching")'],
    passes: ['(the README)'],
  },
  {
    id: 'the-platform',
    pattern: /\b(?:the|this)(?:-|_? +)platform(?![\da-z])/giu,
    why: 'these packages speak of a host',
    finds: [
      'this platform',
      "the platform's policy",
      'this\nplatform',
      'the\n   * platform',
      'thisPlatform',
      'this-platform',
    ],
    passes: [
      'a platform',
      'the platforms',
      'theplatform',
      'this\n\nplatform',
      'the\n *\n * platform',
    ],
  },
];

/**
 * Identifiers upwind ships, blanked out of a file before it is searched, column for column. Each
 * names a header, a variable, a directory, a module, a marker, a cache or a value upwind publishes,
 * and renaming one is a change to that contract of its own; an addition here is reviewed as one.
 */
const ALLOWED: readonly RegExp[] = [
  /x-arkor-[\w-]+/giu,
  /\bARKOR_\w+/gu,
  /\.arkor\//gu,
  /\barkor:[\w./-]*/gu,
  /__arkor\b/gu,
  /\barkor-(?:csp|edge)\b/gu,
  // The kind of artifact a document's shell is (`artifactKindSchema` in `@stayingupwind/core`):
  // the name alone, not another made from it on either side.
  /(?<![\w-])ppr-shell(?![\w-])/gu,
  // The copyright holder, as every package's licence and notice name it.
  /\bCopyright (?:\(c\) )?\d{4} Arkor and Contributors\b/gu,
];

function blankAllowed(text: string): string {
  let blanked = text;
  for (const pattern of ALLOWED) {
    blanked = blanked.replaceAll(pattern, (match) => ' '.repeat(match.length));
  }
  return blanked;
}

/** What opens a line that carries on a comment or a quote: `//`, `/*`, `*`, `#`, `>`. */
const OPENERS = new Set(['#', '*', '/', '>']);

/** A line with its indent and what opens it blanked, column for column: it reads as indent. */
function blankOpener(line: string): string {
  let end = line.length - line.trimStart().length;
  while (end < line.length && OPENERS.has(line.charAt(end))) {
    end += 1;
  }
  return ' '.repeat(end) + line.slice(end);
}

/**
 * Whitespace as a reader takes it, column for column. A run within a line, or across one line break
 * — a soft break, which Markdown renders as a space and a reader of a wrapped comment reads across —
 * becomes spaces; a run across two or more is a paragraph's end, and stays the line breaks it is.
 */
function softBreaksAsSpaces(text: string): string {
  return text.replaceAll(/\s+/gu, (space) =>
    space.indexOf('\n') === space.lastIndexOf('\n') ? ' '.repeat(space.length) : space,
  );
}

/**
 * Where an identifier's words meet: a capital after a lower-case letter or a digit (`controlPlane`),
 * the last capital of a run before a lower-case letter (`HTTPServer`), and what follows a `_`
 * (`control_plane`, which keeps its `_` so that `ppr_` still reads as the name it is).
 */
const WORD_JOIN = /(?<=[\da-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=_)(?=[\dA-Za-z])/gu;

/** A file as its terms are searched for, and the offset each of its characters has in the file. */
export interface Searchable {
  readonly text: string;
  readonly offsets: readonly number[];
}

/**
 * A file as its terms are searched for: what lines have shifted and what identifiers join read as
 * the words they are, `controlPlane` as `control Plane` and `control_plane` as `control_ plane`. A
 * space put between two words stands at the offset of the second.
 */
export function searchable(text: string): Searchable {
  const opened = text
    .split('\n')
    .map((line) => blankOpener(line))
    .join('\n');
  const read = softBreaksAsSpaces(blankAllowed(opened));
  let spaced = '';
  const offsets: number[] = [];
  let from = 0;
  for (const join of [...read.matchAll(WORD_JOIN), { index: read.length }]) {
    for (let at = from; at < join.index; at += 1) {
      offsets.push(at);
    }
    spaced += read.slice(from, join.index);
    if (join.index < read.length) {
      offsets.push(join.index);
      spaced += ' ';
    }
    from = join.index;
  }
  return { text: spaced, offsets };
}
