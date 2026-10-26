import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repository = path.resolve(import.meta.dirname, '../../..');

function provenanceStep(): string {
  const workflow = readFileSync(path.join(repository, '.github/workflows/publish.yaml'), 'utf8');
  const provenance = workflow.split('\n  provenance:\n', 2)[1]?.split('\n  draft:', 1)[0] ?? '';
  const marker = '        run: |\n';
  const step = provenance.slice(
    provenance.indexOf('- name: The registry holds a provenance attestation'),
  );
  return step
    .slice(step.indexOf(marker) + marker.length)
    .split('\n')
    .map((line) => (line.startsWith(' '.repeat(10)) ? line.slice(10) : line))
    .join('\n');
}

describe('provenance metadata isolation', () => {
  it('reads package JSON as data and URL-encodes scoped names and versions without npm', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'upwind-provenance-security-'));
    try {
      const bin = path.join(root, 'bin');
      const packageDir = path.join(root, "packages/a');process.exit(7);('");
      mkdirSync(bin);
      mkdirSync(packageDir, { recursive: true });
      const name = '@stayingupwind/sdk';
      const version = '1.0.0-beta.1+build';
      writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, version }));
      const metadata = path.join(root, 'metadata');
      writeFileSync(
        metadata,
        JSON.stringify({
          dist: {
            attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
          },
        }),
      );
      const argumentsFile = path.join(root, 'curl-arguments');
      writeFileSync(
        path.join(bin, 'curl'),
        `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.CURL_ARGUMENTS, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(fs.readFileSync(process.env.REGISTRY_METADATA));\n`,
        { mode: 0o700 },
      );
      const body = provenanceStep();
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- Bash runs only the inline workflow reader against this private fixture.
      const result = spawnSync('bash', ['-c', body], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          TAG: `v${version}`,
          PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`,
          CURL_ARGUMENTS: argumentsFile,
          REGISTRY_METADATA: metadata,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`${name}@${version}: https://slsa.dev/provenance/v1`);

      const args: unknown = JSON.parse(readFileSync(argumentsFile, 'utf8'));

      expect(args).toStrictEqual([
        '--disable',
        '-fsS',
        '--connect-timeout',
        '5',
        '--max-time',
        '20',
        '--max-filesize',
        '1048576',
        `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
      ]);
      expect(body).not.toMatch(/\b(?:npm|pnpm|yarn)\s+[a-z]/u);
      expect(body).not.toMatch(/require\(['"]\.\//u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
