import { cp, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const EXCLUDED = new Set([
  '.git',
  '.aws',
  '.ssh',
  '.gnupg',
  '.npmrc',
  '.yarnrc',
  'node_modules',
  '.next',
  '.arkor',
  '.upwind',
  '.turbo',
  '.wrangler',
  'coverage',
]);

export function excludedBuildPath(relative: string): boolean {
  return relative
    .split(/[\\/]/u)
    .some(
      (part) =>
        EXCLUDED.has(part) || part === '.env' || part.startsWith('.env.') || part.endsWith('.env'),
    );
}

function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** A caller's Dockerfile/dockerignore cannot add credentials back to this private context. */
export async function copyBuildContext(source: string, destination: string): Promise<void> {
  const root = await realpath(source);
  await cp(root, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: async (file) => {
      if (excludedBuildPath(path.relative(root, file))) return false;
      const info = await lstat(file);
      if (info.isSymbolicLink() && !contained(root, await realpath(file))) {
        throw new Error(`build context contains an external symlink: ${path.relative(root, file)}`);
      }
      if (path.basename(file) === '.yarnrc.yml') {
        const text = await readFile(file, 'utf8');
        // Keep workspace configuration, but refuse credentials embedded in configuration files.
        for (const line of text.split('\n')) {
          const value = /^\s*npmAuth(?:Token|Ident)\s*:\s*(.*)$/u.exec(line)?.[1]?.trim();
          if (value !== undefined && !/^["']?\$\{[A-Z_a-z][A-Z_a-z0-9]*\}["']?$/u.test(value)) {
            throw new Error(
              'move Yarn authentication values to declared build environment variables',
            );
          }
        }
      }
      return true;
    },
  });
}

export interface PackageInstall {
  readonly manager: 'pnpm' | 'npm' | 'yarn' | 'bun';
  readonly specification: string;
  readonly command: readonly string[];
}

/** Installing from a manifest without its lockfile would defeat the target-platform build. */
export async function packageInstall(context: string): Promise<PackageInstall> {
  const manifest = JSON.parse(await readFile(path.join(context, 'package.json'), 'utf8')) as {
    readonly packageManager?: unknown;
  };
  const candidates = [
    ['pnpm', 'pnpm-lock.yaml'],
    ['npm', 'package-lock.json'],
    ['yarn', 'yarn.lock'],
    ['bun', 'bun.lock'],
    ['bun', 'bun.lockb'],
  ] as const;
  const found: (typeof candidates)[number][] = [];
  for (const candidate of candidates) {
    try {
      if ((await lstat(path.join(context, candidate[1]))).isFile()) found.push(candidate);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
  if (found.length !== 1 || found[0] === undefined) {
    throw new Error('build.context must contain exactly one supported package-manager lockfile');
  }
  const manager = found[0][0];
  const declared = manifest.packageManager;
  if (
    declared !== undefined &&
    (typeof declared !== 'string' ||
      !/^(?:pnpm|npm|yarn|bun)@\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+sha(?:224|256|384|512)\.[\w+/=.-]+)?$/u.test(
        declared,
      ) ||
      !declared.startsWith(`${manager}@`))
  ) {
    throw new Error(
      'packageManager must pin the package manager that owns build.context’s lockfile',
    );
  }
  if (manager !== 'npm' && typeof declared !== 'string') {
    throw new Error('set an exact packageManager version in build.context/package.json');
  }
  const specification = typeof declared === 'string' ? declared : 'npm';
  const major = typeof declared === 'string' ? Number(declared.split('@')[1]?.split('.')[0]) : 0;
  const binary =
    manager === 'bun' ? ['bun'] : specification === 'npm' ? ['npm'] : ['corepack', specification];
  const frozen =
    manager === 'npm'
      ? ['ci', '--include=dev']
      : manager === 'yarn' && major >= 2
        ? ['install', '--immutable']
        : ['install', '--frozen-lockfile'];
  return { manager, specification, command: [...binary, ...frozen] };
}

export async function buildDirectories(
  projectDir: string,
  contextSetting: string,
): Promise<{
  readonly context: string;
  readonly project: string;
  readonly relativeProject: string;
}> {
  const project = await realpath(projectDir);
  const context = await realpath(path.resolve(project, contextSetting));
  if (!contained(context, project))
    throw new Error('build.context must contain the application directory');
  return {
    context,
    project,
    relativeProject: path.relative(context, project).split(path.sep).join('/'),
  };
}
