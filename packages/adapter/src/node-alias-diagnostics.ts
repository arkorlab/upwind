import { AuditError } from './dependencies.ts';
import { retainedFileIdentity } from './node-proof-diagnostics.ts';
import type { NodeSourceSpecifier } from './node-source-specifiers.ts';

export const OUTSIDE_CLOSED_TRACE =
  'The first existing Node package target is outside its closed trace';
const TARGETS = new WeakMap<AuditError, string>();
const MAX_SPECIFIER_CHARACTERS = 240;

/** Preserve the exact inner message used to classify an optional, unproved layout hint. */
export function nodeAliasOutsideTrace(target: string): AuditError {
  const error = new AuditError(OUTSIDE_CLOSED_TRACE);
  TARGETS.set(error, target);
  return error;
}

/** Required lookups only: no source contents, absolute roots or arbitrary error properties. */
export function nodeAliasLookupError(
  error: unknown,
  root: string,
  importer: string,
  load: NodeSourceSpecifier & { readonly requiredInput?: boolean | undefined },
): unknown {
  if (!(error instanceof AuditError)) return error;
  const specifier =
    load.specifier.length > MAX_SPECIFIER_CHARACTERS
      ? `${load.specifier.slice(0, MAX_SPECIFIER_CHARACTERS)}…`
      : load.specifier;
  const target = TARGETS.get(error);
  const resolved = target === undefined ? '' : `, target=${retainedFileIdentity(root, target)}`;
  const role =
    load.requiredInput === undefined ? '' : `, requiredInput=${String(load.requiredInput)}`;
  return new AuditError(
    `${error.message} (importer=${retainedFileIdentity(root, importer)}, specifier=${JSON.stringify(specifier)}, kind=${JSON.stringify(load.kind)}${resolved}${role})`,
    { cause: error },
  );
}
