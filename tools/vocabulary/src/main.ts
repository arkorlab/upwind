import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { annotationOf } from './annotate.ts';
import { type Hit, hitsOfFile, hitsOfPath, selfCheck, textOf } from './scan.ts';

/**
 * Holds the packages that serve and deploy a deployment to the words any host would use.
 *
 * Those packages are an edge, the runtime cache behind it, the assembly that deploys a build to
 * them, what the three share, and the stack that runs them on one machine. Each is written for
 * whichever host runs it, so none of them may describe one host in particular: not by name, not by
 * the names of its own resources or the parts it is made of, not by where it keeps its storage.
 * The terms are in `terms.ts`, each with the reason it is out.
 *
 * There is no baseline: a package here says none of them. A file is searched whole, and a term of
 * several words is found where a line break falls inside it, as a wrapped comment or a Markdown
 * paragraph reads it.
 *
 *   node tools/vocabulary/src/main.ts [--format github]
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

/** The packages held to it, by directory. One that does not exist yet is held once it does. */
const GATED = [
  'packages/cache',
  'packages/deploy',
  'packages/edge',
  'packages/host',
  'packages/local',
  // The command that deploys them, which is no host's either.
  'packages/upwind/src/deploy',
  'packages/upwind/test/deploy',
];

const EXIT_HITS = 1;
const EXIT_USAGE = 2;
const KIB = 1024;
const MIB = KIB * KIB;
/** Far past what `git ls-files` prints for those packages. */
const GIT_OUTPUT_LIMIT_MIB = 64;

/** By UTF-16 code unit: the same order on every machine and locale. */
function byCodeUnit(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
}

/** What `git ls-files` lists of those packages with these options. */
function listed(options: readonly string[]): string[] {
  return execFileSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- the developer's own git, reached through their own PATH.
    'git',
    ['ls-files', ...options, '-z', '--', ...GATED],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: GIT_OUTPUT_LIMIT_MIB * MIB },
  )
    .split('\0')
    .filter((file) => file !== '');
}

/**
 * The text files those packages hold, tracked or not, minus what `.gitignore` leaves out. A file
 * deleted from the working tree is in the index until its deletion is staged; what is read is the
 * tree as it stands, so such a file is not there to be read.
 */
function gatedFiles(): { readonly file: string; readonly text: string | undefined }[] {
  const deleted = new Set(listed(['--deleted']));
  return listed(['--cached', '--others', '--exclude-standard'])
    .filter((file) => !deleted.has(file))
    .toSorted(byCodeUnit)
    .map((file) => ({ file, text: textOf(file, readFileSync(path.join(REPO_ROOT, file))) }));
}

function report(hits: readonly Hit[], github: boolean): void {
  for (const hit of hits) {
    const where =
      hit.inPath === true
        ? `${hit.file} (path)`
        : `${hit.file}:${String(hit.line)}:${String(hit.column)}`;
    if (github) {
      console.log(annotationOf(hit));
    } else {
      console.error(`${where}  ${hit.term.id}  ${JSON.stringify(hit.text)}: ${hit.term.why}`);
    }
  }
}

function main(args: readonly string[]): number {
  const wrong = selfCheck();
  if (wrong.length > 0) {
    for (const line of wrong) {
      console.error(`vocabulary: term ${line}`);
    }
    return EXIT_USAGE;
  }
  const github = args.join(' ') === '--format github';
  if (!github && args.length > 0) {
    console.error('usage: node tools/vocabulary/src/main.ts [--format github]');
    return EXIT_USAGE;
  }
  const files = gatedFiles();
  // A binary's name is read even where its bytes are not.
  const hits = files.flatMap(({ file, text }) => {
    const said = text === undefined ? [] : hitsOfFile(file, text);
    return [...hitsOfPath(file), ...said];
  });
  const read = files.filter(({ text }) => text !== undefined).length;
  report(hits, github);
  console.log(
    `vocabulary: ${String(files.length)} paths and ${String(read)} files read, ${String(hits.length)} terms found`,
  );
  return hits.length === 0 ? 0 : EXIT_HITS;
}

/** A file that cannot be read as text is said as such, not thrown. */
function run(args: readonly string[]): number {
  try {
    return main(args);
  } catch (error) {
    console.error(`vocabulary: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_USAGE;
  }
}

process.exitCode = run(process.argv.slice(2));
