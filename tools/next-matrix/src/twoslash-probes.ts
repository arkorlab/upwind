import assert from 'node:assert/strict';

const SAFE_TOKEN = /^[\w.-]{1,64}$/u;
const PROBE_STAGES = new Set([
  'entry-table-import',
  'linked-import',
  'route-import',
  'route-ready',
  'runtime-import',
]);
const PROBE_OUTCOMES = new Set(['failed', 'success', 'unsupported']);

export interface Failure {
  name: string;
  code: string | null;
}

export interface ImportProbe {
  stage: string;
  outcome: string;
  error?: Failure;
  undefinedPathArgument?: boolean;
}

function tokenOf(value: unknown): string | null {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : null;
}

/** Store only bounded error identities, never messages, stacks, filenames or source. */
export function failureOf(error: unknown): Failure {
  const name = error instanceof Error ? error.name : typeof error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  return {
    name: tokenOf(name) ?? 'unknown',
    code: tokenOf(code),
  };
}

/** A separate isolate probes lazy imports only after the unmodified Function was exercised. */
export function importProbeSource(rootId: string): string {
  return String.raw`export default {
    async fetch() {
      let stage = 'runtime-import';
      try {
        await import('./index.mjs');
        stage = 'entry-table-import';
        const app = await import('./app.cjs');
        const load = app.default?.entries?.[${JSON.stringify(rootId)}];
        if (typeof load !== 'function') return Response.json({ stage, outcome: 'unsupported' });
        stage = 'route-import';
        await load();
        return Response.json({ stage: 'route-ready', outcome: 'success' });
      } catch (error) {
        const token = (value) => typeof value === 'string' && /^[\w.-]{1,64}$/.test(value) ? value : null;
        return Response.json({ stage, outcome: 'failed', error: { name: token(error?.name), code: token(error?.code) } });
      }
    }
  };`;
}

/** Import only the emitted linked package in a fresh isolate, without the application runtime. */
export function linkedImportProbeSource(moduleName: string): string {
  return String.raw`export default {
    async fetch() {
      try {
        await import(${JSON.stringify(`./${moduleName}`)});
        return Response.json({ stage: 'linked-import', outcome: 'success' });
      } catch (error) {
        const token = (value) => typeof value === 'string' && /^[\w.-]{1,64}$/.test(value) ? value : null;
        const undefinedPathArgument = error?.code === 'ERR_INVALID_ARG_VALUE'
          && typeof error.message === 'string'
          && error.message.includes("The argument 'path'")
          && error.message.includes("Received 'undefined'");
        return Response.json({ stage: 'linked-import', outcome: 'failed', undefinedPathArgument, error: { name: token(error?.name), code: token(error?.code) } });
      }
    }
  };`;
}

export function importProof(body: string): ImportProbe {
  const value = JSON.parse(body) as unknown;
  assert.ok(typeof value === 'object' && value !== null, 'import probe returned no object');
  assert.ok(
    'stage' in value && typeof value.stage === 'string' && PROBE_STAGES.has(value.stage),
    'import probe returned an unknown stage',
  );
  assert.ok(
    'outcome' in value && typeof value.outcome === 'string' && PROBE_OUTCOMES.has(value.outcome),
    'import probe returned an unknown outcome',
  );
  const proof: ImportProbe = { stage: value.stage, outcome: value.outcome };
  if ('undefinedPathArgument' in value && typeof value.undefinedPathArgument === 'boolean') {
    proof.undefinedPathArgument = value.undefinedPathArgument;
  }
  if ('error' in value && typeof value.error === 'object' && value.error !== null) {
    proof.error = {
      name: 'name' in value.error ? (tokenOf(value.error.name) ?? 'unknown') : 'unknown',
      code: 'code' in value.error ? tokenOf(value.error.code) : null,
    };
  }
  return proof;
}
