import path from 'node:path';

const TARGETS = ['bufferutil', 'utf-8-validate'] as const;
const SUFFIXES = ['', '.js', '.json', '.node'] as const;

interface Alias {
  readonly path: string;
  readonly target: string;
}

function inside(name: string, directory: string): boolean {
  return name === directory || name.startsWith(`${directory}/`);
}

/** The absent-only profile cannot acquire an optional target through another archived route. */
export function nodeWsOptionalArchiveRefusal(
  importer: string,
  names: readonly string[],
  links: readonly Alias[],
): string | undefined {
  if (
    importer === '' ||
    importer.includes('\\') ||
    importer.includes('\0') ||
    importer.includes(':') ||
    importer.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    return 'invalid optional-loader archive coordinate';
  const files = new Set(names);
  for (let directory = path.posix.dirname(importer); ; directory = path.posix.dirname(directory)) {
    if (path.posix.basename(directory) !== 'node_modules') {
      for (const target of TARGETS) {
        const candidate = path.posix.join(directory, 'node_modules', target);
        if (
          SUFFIXES.some((suffix) => files.has(candidate + suffix)) ||
          names.some((name) => inside(name, candidate)) ||
          links.some((link) => {
            return SUFFIXES.some((suffix) => {
              const file = candidate + suffix;
              return inside(file, link.path) || inside(link.path, file);
            });
          })
        )
          return 'optional WebSocket native target or lookup alias is present in the archive';
      }
    }
    if (directory === '.') break;
  }
  return undefined;
}
