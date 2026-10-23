import { reportingEndpointNames } from './reporting-endpoints.ts';

const CSP = 'content-security-policy';
const REPORT_ONLY = 'content-security-policy-report-only';
const ENDPOINTS = 'reporting-endpoints';
const REPORTING_DIRECTIVE = /^report-(?:to|uri)(?:[\t\n\f\r ]|$)/iu;
const HTML = new Set(['application/xhtml+xml', 'text/html']);
const COLLECTOR_ESCAPE = /%[\da-fA-F]{2}|[^\w!#$&'()*+./:=?@[\]~-]/gu;
const PERCENT_ESCAPE_LENGTH = 3;
/**
 * The reporting group the edge names its endpoint by, where a policy does not already name it; a
 * policy that does gets the first free one after it (`arkor-csp-1`, …).
 */
const CSP_REPORT_GROUP = 'arkor-csp';

function hasReporting(policy: string): boolean {
  return policy.split(';').some((directive) => REPORTING_DIRECTIVE.test(directive.trimStart()));
}

function endpointGroup(
  names: ReadonlySet<string>,
  enforcing: string | null,
  monitored: string | null,
): string {
  const occupied = new Set(names);
  for (const policy of [enforcing, monitored]) {
    for (const name of referencedGroups(policy)) {
      occupied.add(name);
    }
  }
  if (!occupied.has(CSP_REPORT_GROUP)) {
    return CSP_REPORT_GROUP;
  }
  let suffix = 1;
  while (occupied.has(`${CSP_REPORT_GROUP}-${String(suffix)}`)) {
    suffix += 1;
  }
  return `${CSP_REPORT_GROUP}-${String(suffix)}`;
}

function referencedGroups(value: string | null): string[] {
  if (value === null || !/report-to/iu.test(value)) {
    return [];
  }
  return value.split(/[;,]/u).flatMap((directive) => {
    const [name, ...groups] = directive.trim().split(/\s+/u);
    return name?.toLowerCase() === 'report-to' ? groups : [];
  });
}

function eligible(value: string | null): boolean {
  return value?.split(',').some((policy) => policy.trim() !== '' && !hasReporting(policy)) ?? false;
}

function appendReporting(value: string, addition: string): string {
  return value
    .split(',')
    .map((policy) => {
      if (policy.trim() === '' || hasReporting(policy)) {
        return policy;
      }
      return `${policy.trimEnd().replace(/;$/u, '')}${addition}`;
    })
    .join(',');
}

function amendPolicy(headers: Headers, name: string, value: string | null, addition: string): void {
  if (value === null) {
    return;
  }
  const amended = appendReporting(value, addition);
  if (amended !== value) {
    headers.set(name, amended);
  }
}

function collectorUri(path: string): string | undefined {
  try {
    // Preserve URI syntax and existing escapes, but encode CSP's policy/directive delimiters too.
    // The ASCII result contains neither quotes nor backslashes, so it also fits an SF String.
    return path.replaceAll(COLLECTOR_ESCAPE, (character) => {
      if (character.length === PERCENT_ESCAPE_LENGTH) {
        return character;
      }
      return encodeURIComponent(character);
    });
  } catch {
    // A lone surrogate cannot name a UTF-8 URI. Leave the application's policy untouched.
    return undefined;
  }
}

/**
 * Reporting is outgoing metadata, never a change to the stored document. Callers already own
 * mutable Headers, so the body streams unchanged and no Response, I/O or crypto is added here.
 * The host's collector path is absent on validation, for a fronted origin, and wherever the host
 * gives none.
 */
export function applyCspReporting(headers: Headers, path: string | undefined): void {
  if (path === undefined) {
    return;
  }
  const enforcing = headers.get(CSP);
  const monitored = headers.get(REPORT_ONLY);
  if (enforcing === null && monitored === null) {
    return;
  }
  const contentType = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType === undefined || !HTML.has(contentType)) {
    return;
  }
  if (!eligible(enforcing) && !eligible(monitored)) {
    return;
  }
  const collector = collectorUri(path);
  if (collector === undefined) {
    return;
  }
  const existing = headers.get(ENDPOINTS);
  const names = existing === null ? new Set<string>() : reportingEndpointNames(existing);
  // An application's own group may be unresolved, or configured through the older Report-To
  // header: defining it here would send that preserved policy's reports to the host's endpoint.
  const group = names === undefined ? undefined : endpointGroup(names, enforcing, monitored);
  const modern = group === undefined ? '' : `; report-to ${group}`;
  const addition = `; report-uri ${collector}${modern}`;
  amendPolicy(headers, CSP, enforcing, addition);
  amendPolicy(headers, REPORT_ONLY, monitored, addition);
  if (group !== undefined) {
    const member = `${group}="${collector}"`;
    headers.set(
      ENDPOINTS,
      existing === null || existing.trim() === '' ? member : `${existing}, ${member}`,
    );
  }
}
