/** The npm release whose release-age and exotic-dependency switches this hook supports. */
export const INSTALL_NPM_VERSION = '11.19.1';

const AGE_EXCEPTIONS = [
  '@next/*',
  '@turbo/*',
  '@vercel/*',
  '@workflow/*',
  'babel-plugin-react-compiler',
  'next',
  'react',
  'react-dom',
  'react-is',
  'react-server-dom-*',
  'scheduler',
  'turbo',
];

// Next.js 16.4.3's test-install security profile. Its five version-qualified exceptions cannot be
// represented by npm's name-only matcher; omitting them makes the npm install more restrictive.
const UPSTREAM_EXCEPTIONS = [
  '@mswjs/interceptors@0.42.5',
  '@next/*',
  '@turbo/*',
  '@types/react@19.2.18',
  '@types/react-dom@19.2.4',
  '@vercel/*',
  '@workflow/*',
  'babel-plugin-react-compiler',
  'httpxy@0.5.5',
  'next',
  'react',
  'react-dom',
  'react-is',
  'react-server-dom-*',
  'satori@0.33.5',
  'scheduler',
  'turbo',
];

const WORKSPACE_JSON = `${JSON.stringify(
  {
    blockExoticSubdeps: true,
    minimumReleaseAge: 2880,
    minimumReleaseAgeExclude: UPSTREAM_EXCEPTIONS,
  },
  null,
  2,
)}\n`;

// js-yaml's output for that exact profile. Accepting a fixed serialization avoids interpreting
// arbitrary YAML (including duplicate keys, aliases or another workspace's stricter policy).
const WORKSPACE_YAML = `blockExoticSubdeps: true
minimumReleaseAge: 2880
minimumReleaseAgeExclude:
${UPSTREAM_EXCEPTIONS.map((name) => {
  return `  - ${name.startsWith('@') ? `'${name}'` : name}`;
}).join('\n')}
`;

/** Refuse custom pnpm settings rather than silently dropping them when npm is selected. */
export function acceptsNpmWorkspace(source: string | undefined): boolean {
  if (source === undefined) {
    return true;
  }
  const normalized = source.replaceAll('\r\n', '\n');
  return normalized === WORKSPACE_JSON || normalized === WORKSPACE_YAML;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameExceptions(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === AGE_EXCEPTIONS.length &&
    value.every((entry, index) => entry === AGE_EXCEPTIONS[index])
  );
}

function acceptsAge(config: Record<string, unknown>): boolean {
  const age = config['min-release-age'];
  const exceptions = config['min-release-age-exclude'];
  const defaults = age === null && Array.isArray(exceptions) && exceptions.length === 0;
  return defaults || (age === 2 && sameExceptions(exceptions));
}

/** CLI flags must not override a stricter user/project npm policy. Other npm settings stay intact. */
export function acceptsNpmConfig(value: unknown): boolean {
  if (
    !record(value) ||
    value['before'] !== null ||
    value['force'] !== false ||
    value['global'] !== false ||
    !acceptsAge(value)
  ) {
    return false;
  }
  return ['allow-git', 'allow-remote', 'allow-directory', 'allow-file'].every((key) => {
    return value[key] === 'all' || value[key] === 'root';
  });
}

/** Arguments, not shell text: the package-name globs must reach npm without shell expansion. */
export function npmInstallArguments(): string[] {
  return [
    'install',
    '--include=dev',
    '--no-audit',
    '--no-fund',
    '--package-lock=true',
    '--min-release-age=2',
    '--allow-git=root',
    '--allow-remote=root',
    '--allow-directory=root',
    '--allow-file=root',
    ...AGE_EXCEPTIONS.map((name) => `--min-release-age-exclude=${name}`),
  ];
}
