import { createHash } from 'node:crypto';

export type Resources = Record<string, Record<string, unknown>>;
export type Outputs = Record<string, Record<string, unknown>>;

export function ref(name: string): Record<string, string> {
  return { Ref: name };
}

export function attribute(name: string, field: string): Record<string, readonly string[]> {
  return { 'Fn::GetAtt': [name, field] };
}

export function substitute(value: string): Record<string, string> {
  return { 'Fn::Sub': value };
}

export function resourceName(project: string): string {
  const digest = createHash('sha256').update(project).digest('hex').slice(0, 8);
  return `${project.slice(0, 23)}-${digest}`;
}

export function tags(project: string): readonly Record<string, string>[] {
  return [
    { Key: 'upwind:project', Value: project },
    { Key: 'upwind:managed', Value: 'true' },
  ];
}

export function output(value: unknown): Record<string, unknown> {
  return { Value: value };
}
