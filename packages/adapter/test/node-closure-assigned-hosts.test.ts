import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { isNode } from '../src/lexical-scope.ts';
import {
  analyzeAssignedNodeHosts,
  assignedNodeHosts,
  hostObjectOf,
} from '../src/node-closure-hosts.ts';
import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';
import { visitTree } from '../src/node-manifest-consumer-ast.ts';
import type { NodeNextCacheWriteProof } from '../src/node-next-cache-write-proof.ts';

const FILE = '/project/node_modules/authored/index.js';
const DECLARE = 'var host;host=globalThis;';
const OPTIONAL_PROCESS = '(host=globalThis)==null?void 0:host.process';
function program(code: string) {
  const parsed: unknown = parseAst(code);
  if (!isNode(parsed)) throw new Error('missing authored program');
  return parsed;
}
function hostVisit(parsed: ReturnType<typeof program>) {
  const found = visitTree(parsed).find((visit) => {
    return (
      visit.node.type === 'Identifier' &&
      visit.node['name'] === 'host' &&
      visit.parent?.type === 'MemberExpression'
    );
  });
  if (found === undefined) throw new Error('missing authored host');
  return found;
}
function completeVisit(visit: ReturnType<typeof visitTree>[number]) {
  return { node: visit.node, parent: visit.parent, key: visit.key, scopes: visit.scopes };
}
function metadataRoot(parsed: ReturnType<typeof program>) {
  const root = visitTree(parsed).find((visit) => {
    const property = visit.parent?.['property'];
    return (
      visit.node.type === 'Identifier' &&
      visit.node['name'] === 'globalThis' &&
      visit.parent?.type === 'MemberExpression' &&
      visit.key === 'object' &&
      isNode(property) &&
      property['name'] === 'memo'
    );
  });
  if (root === undefined) throw new Error('missing authored metadata root');
  return root.node;
}

describe('original assignment host provenance with authored AST only', () => {
  it.each([
    [
      'lowered optional process metadata',
      `var host;const {env,stdout}=(${OPTIONAL_PROCESS})??{};exports.enabled=env&&stdout;`,
    ],
    ['standalone assignment', `${DECLARE}exports.version=host.process.version;`],
    [
      'direct process availability',
      `${DECLARE}exports.version=host.process.version;exports.available=typeof process!=="undefined";`,
    ],
    ['assigned process availability', `${DECLARE}exports.kind=typeof host.process;`],
    ['let assignment', 'let host;host=globalThis;exports.version=host.process.version;'],
    [
      'different identifier',
      'var actual;actual=globalThis;exports.version=actual.process.version;',
    ],
    ['block lexical binding', '{let host;host=globalThis;exports.version=host.process.version;}'],
    [
      'function var binding',
      'function metadata(){var host;host=globalThis;return host.process.version;}exports.metadata=metadata;',
    ],
    [
      'same-name parameter shadow',
      `${DECLARE}exports.local=host=>host.process.dlopen();exports.version=host.process.version;`,
    ],
    [
      'separate same-name writes',
      `${DECLARE}function local(){let host={};host=42;return host;}exports.local=local;exports.version=host.process.version;`,
    ],
    [
      'local globalThis shadow',
      'const globalThis={process:{dlopen:()=>42}};var host;host=globalThis;exports.value=host.process.dlopen();',
    ],
    [
      'ordinary property names',
      `${DECLARE}exports.names={host:42};exports.version=host.process.version;`,
    ],
    [
      'metadata before assignment',
      'var host;exports.kind=typeof host;host=globalThis;exports.version=host.process.version;',
    ],
  ])('preserves %s', (_title, source) => {
    expect(dynamicNodeClosureRefusal(FILE, source)).toBeUndefined();
  });

  it.each([
    [
      'availability does not permit a process escape',
      `${DECLARE}exports.available=typeof process;exports.process=process;`,
    ],
    [
      'availability does not permit a loader',
      `${DECLARE}exports.available=typeof process;host.process.dlopen(module,'addon.node');`,
    ],
    ['global declaration alias', `${DECLARE}const copy=host;exports.version=copy.process.version;`],
    [
      'captured assignment result',
      'var host;const copy=(host=globalThis);exports.version=copy.process.version;',
    ],
    ['global no-op alias redeclaration', `${DECLARE}var copy=host;var copy;copy.eval('unknown');`],
    [
      'process no-op alias redeclaration',
      `${DECLARE}var proc=host.process;var proc;proc.dlopen(module,'unknown.node');`,
    ],
    [
      'process namespace metadata alias',
      `${DECLARE}const proc=host.process;exports.version=proc.version;`,
    ],
    ['direct dlopen', `${DECLARE}host.process.dlopen(module,'unknown.node');`],
    ['computed dlopen', `${DECLARE}host['process']['dlopen'](module,'unknown.node');`],
    [
      'process declaration alias',
      `${DECLARE}const proc=host.process;proc.dlopen(module,'unknown.node');`,
    ],
    [
      'assignment result dlopen',
      "var host;(host=globalThis).process.dlopen(module,'unknown.node');",
    ],
    [
      'conditional dlopen',
      `var host;const {dlopen:load}=(${OPTIONAL_PROCESS})??{};load(module,'unknown.node');`,
    ],
    [
      'conditional process alias',
      `var host;const proc=(${OPTIONAL_PROCESS})??{};proc.dlopen(module,'unknown.node');`,
    ],
    ['global eval', `${DECLARE}host.eval('unknown');`],
    ['global Function', `${DECLARE}const compile=host.Function;compile('unknown')();`],
    ['computed compiler', `${DECLARE}host['eval']('unknown');`],
    ['global require', `${DECLARE}host.require('unknown');`],
    ['CommonJS namespace', `${DECLARE}host.module.require('unknown');`],
    ['CommonJS constructor', `${DECLARE}host.module.constructor._load('unknown');`],
    ['compiler destructuring', `${DECLARE}const {eval:compile}=host;compile('unknown');`],
    ['global rest destructuring', `${DECLARE}const {...copy}=host;copy.eval('unknown');`],
    ['unknown global selector', `${DECLARE}host[unknown]('unknown');`],
    ['optional global selector', `${DECLARE}host?.process;`],
    ['global call escape', `${DECLARE}consume(host);`],
    ['process call escape', `${DECLARE}consume(host.process);`],
    [
      'process returned namespace',
      `${DECLARE}function pick(){return host.process}pick().dlopen(module,'unknown.node');`,
    ],
    ['process alias return', `${DECLARE}const proc=host.process;exports.pick=()=>proc;`],
    ['conditional process return', `var host;exports.pick=()=>(${OPTIONAL_PROCESS})??{};`],
    ['process exported namespace', `${DECLARE}exports.proc=host.process;`],
    ['global return escape', `${DECLARE}exports.read=()=>host;`],
    ['global exported alias', `${DECLARE}exports.host=host;`],
    ['derived alias escape', `${DECLARE}const copy=host;consume(copy);`],
    [
      'derived alias assignment',
      `${DECLARE}let copy=host;copy=unknown;exports.version=copy.process.version;`,
    ],
    ['initialized binding', 'var host={};host=globalThis;exports.version=host.process.version;'],
    [
      'duplicate declaration',
      'var host;var host;host=globalThis;exports.version=host.process.version;',
    ],
    [
      'different later initializer',
      'var host;host=globalThis;var host=unknown;exports.version=host.process.version;',
    ],
    ['unknown later assignment', `${DECLARE}host=unknown;exports.version=host.process.version;`],
    [
      'repeated global assignment',
      `${DECLARE}host=globalThis;exports.version=host.process.version;`,
    ],
    ['compound write', `${DECLARE}host+=unknown;exports.version=host.process.version;`],
    ['update write', `${DECLARE}host++;exports.version=host.process.version;`],
    ['array pattern write', `${DECLARE}[host]=unknown;exports.version=host.process.version;`],
    [
      'object pattern write',
      `${DECLARE}({value:host}=unknown);exports.version=host.process.version;`,
    ],
    ['for target write', `${DECLARE}for(host of unknown){}exports.version=host.process.version;`],
    ['global member write', `${DECLARE}host.changed=true;exports.version=host.process.version;`],
    [
      'derived member write',
      `${DECLARE}const copy=host;copy.changed=true;exports.version=host.process.version;`,
    ],
    [
      'mutated global root',
      'var host;globalThis=unknown;host=globalThis;exports.version=host.process.version;',
    ],
    [
      'formal and var collision',
      'function metadata(host){var host;host=globalThis;return host.process.version;}',
    ],
    [
      'function self collision',
      'const metadata=function host(){var host;host=globalThis;return host.process.version;};',
    ],
    ['undeclared target', 'host=globalThis;exports.version=host.process.version;'],
    [
      'default parameter with distinct body var',
      "var host;function initialize(arg=void(host=globalThis)){var host;}initialize();host.process.dlopen(module,'unknown.node');",
    ],
  ])('refuses %s', (_title, source) => {
    expect(dynamicNodeClosureRefusal(FILE, source)).toBeTypeOf('string');
  });

  it('keeps provenance tied to exact original nodes and leaves source and AST unchanged', () => {
    const code = `${DECLARE}exports.version=host.process.version;`;
    const first = program(code);
    const second = program(code);
    const before = JSON.stringify(first);
    const visits = visitTree(first).map((visit) => completeVisit(visit));
    const assigned = assignedNodeHosts(visits);
    const firstHost = hostVisit(first);
    const secondHost = hostVisit(second);

    expect(assigned.size).toBe(2);
    expect(hostObjectOf(firstHost.node, firstHost.scopes)).toBeUndefined();
    expect(hostObjectOf(firstHost.node, firstHost.scopes, new Set(), assigned)).toBe('global');
    expect(hostObjectOf(secondHost.node, secondHost.scopes, new Set(), assigned)).toBeUndefined();
    expect(JSON.stringify(first)).toBe(before);
    expect(code).toBe(`${DECLARE}exports.version=host.process.version;`);
  });

  it.each([
    ['optional', `${DECLARE}exports.value=host?.process;`, 'MemberExpression'],
    [
      'optional',
      'var host;const {env,stdout}=(host=globalThis)?.process??{};exports.value=env&&stdout;',
      'MemberExpression',
    ],
    ['computed', `${DECLARE}exports.value=host[privateSelector];`, 'MemberExpression'],
    ['loader', `${DECLARE}host.require('private-package');`, 'MemberExpression'],
    ['write', 'var host;(host=globalThis).privateProperty=true;', 'MemberExpression'],
    ['global-escape', `${DECLARE}consumePrivate(host);`, 'Identifier'],
  ])('reports the original %s rejection without changing the empty map', (reason, code, type) => {
    const parsed = program(code);
    const before = JSON.stringify(parsed);
    const visits = visitTree(parsed).map((visit) => completeVisit(visit));
    const analysis = analyzeAssignedNodeHosts(visits);
    const rejection = analysis.rejection;

    expect(rejection).toMatchObject({ reason, visit: { node: { type } } });
    expect(visits).toContain(rejection?.visit);
    expect(analysis.assigned.size).toBe(0);
    expect([...assignedNodeHosts(visits)]).toStrictEqual([...analysis.assigned]);
    expect(analysis.diagnostic).toMatch(
      /^assigned global (?:optional|computed|loader|write|global-escape) \((?:MemberExpression|Identifier) at \d+:\d+\)$/u,
    );
    expect(dynamicNodeClosureRefusal(FILE, code)).toBe(
      `an unproved rebound Node loader namespace (${analysis.diagnostic})`,
    );
    expect(analysis.diagnostic).not.toMatch(/private|consume|host|package|[/\\]/u);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it('keeps all candidates rejected and reports the first rejection in supplied visit order', () => {
    const code =
      'var first;first=globalThis;exports.version=first.process.version;var second;second=globalThis;second?.process;second[privateSelector];';
    const visits = visitTree(program(code)).map((visit) => completeVisit(visit));
    const firstRejected = visits.find(
      (visit) => visit.node.type === 'MemberExpression' && visit.node['computed'] === true,
    );
    const analysis = analyzeAssignedNodeHosts(visits);

    expect(analysis.assigned.size).toBe(0);
    expect(analysis.rejection?.visit).toBe(firstRejected);
    expect(analysis.rejection?.reason).toBe('computed');
    expect(assignedNodeHosts(visits).size).toBe(0);
  });

  it('keeps accepted original provenance and has a static fallback for an ineligible assignment', () => {
    const safe = visitTree(program(`${DECLARE}exports.version=host.process.version;`)).map(
      (visit) => completeVisit(visit),
    );
    const accepted = analyzeAssignedNodeHosts(safe);
    const ineligible = `${DECLARE}host=unknown;`;
    const rejected = analyzeAssignedNodeHosts(
      visitTree(program(ineligible)).map((visit) => completeVisit(visit)),
    );

    expect(accepted.assigned.size).toBe(2);
    expect(accepted.rejection).toBeUndefined();
    expect([...assignedNodeHosts(safe)]).toStrictEqual([...accepted.assigned]);
    expect(rejected.assigned.size).toBe(0);
    expect(rejected.rejection).toBeUndefined();
    expect(rejected.diagnostic).toBe('no eligible single globalThis assignment');
    expect(dynamicNodeClosureRefusal(FILE, ineligible)).toBe(
      'an unproved rebound Node loader namespace (no eligible single globalThis assignment)',
    );
  });

  it('does not change metadata destructuring or admit fixed string keys', () => {
    const lowered = `var host;const {env,stdout}=(${OPTIONAL_PROCESS})??{};exports.value=env&&stdout;`;
    const stringKey = `${DECLARE}const {'env':env}=host.process;exports.value=env;`;
    const analysis = analyzeAssignedNodeHosts(
      visitTree(program(stringKey)).map((visit) => completeVisit(visit)),
    );

    expect(dynamicNodeClosureRefusal(FILE, lowered)).toBeUndefined();
    expect(analysis.assigned.size).toBe(2);
    expect(analysis.rejection).toBeUndefined();
    expect(dynamicNodeClosureRefusal(FILE, stringKey)).toBe(
      'an unproved assigned Node process namespace escape',
    );
  });

  it('omits unavailable source ranges instead of including arbitrary values', () => {
    const visits = visitTree(program(`${DECLARE}host?.process;`)).map((visit) =>
      completeVisit(visit),
    );
    const altered = visits.map((visit) => {
      return visit.node['optional'] === true
        ? { ...visit, node: { ...visit.node, start: -1, end: Infinity } }
        : visit;
    });
    const analysis = analyzeAssignedNodeHosts(altered);

    expect(analysis.assigned.size).toBe(0);
    expect(analysis.rejection?.reason).toBe('optional');
    expect(analysis.diagnostic).toBe('assigned global optional (MemberExpression)');
  });

  it('uses exact supplied roots as DATA only and keeps the default path refusing', () => {
    const code = `globalThis.memo=42;${DECLARE}exports.version=host.process.version;`;
    const parsed = program(code);
    const before = JSON.stringify(parsed);
    const visits = visitTree(parsed).map((visit) => completeVisit(visit));
    const actual = analyzeAssignedNodeHosts(visits, new Set([metadataRoot(parsed)]));
    const copiedRoot = metadataRoot(program(code));
    const copied = analyzeAssignedNodeHosts(visits, new Set([copiedRoot]));

    expect(actual.assigned.size).toBe(2);
    expect(actual.rejection).toBeUndefined();
    expect(copied.assigned.size).toBe(0);
    expect(assignedNodeHosts(visits).size).toBe(0);
    expect(dynamicNodeClosureRefusal(FILE, code)).toContain('rebound Node loader namespace');
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it('keeps every unprovided write and every assigned alias write counted', () => {
    const code = `globalThis.memo=42;globalThis.other=43;${DECLARE}host.memo=44;exports.version=host.process.version;`;
    const parsed = program(code);
    const visits = visitTree(parsed).map((visit) => completeVisit(visit));
    const allIdentifiers = new Set(
      visits.filter((visit) => visit.node.type === 'Identifier').map((visit) => visit.node),
    );
    const oneRoot = new Set([metadataRoot(parsed)]);

    expect(analyzeAssignedNodeHosts(visits, oneRoot).assigned.size).toBe(0);
    expect(analyzeAssignedNodeHosts(visits, allIdentifiers).assigned.size).toBe(0);
    expect(dynamicNodeClosureRefusal(FILE, code)).toContain('rebound Node loader namespace');
  });

  it.each([
    'globalThis=unknown;',
    'globalThis.globalThis=unknown;',
    'globalThis.process=unknown;',
    'globalThis.module=unknown;',
    'globalThis.require=unknown;',
    'globalThis.eval=unknown;',
    'globalThis.Function=unknown;',
    'globalThis.__proto__=unknown;',
    'globalThis.constructor=unknown;',
    'globalThis.prototype=unknown;',
    "globalThis['memo']=42;",
    'globalThis[unknown]=42;',
    'delete globalThis.memo;',
    'globalThis.memo++;',
    'globalThis.memo+=42;',
    'globalThis.memo.nested=42;',
    'host.memo=42;',
  ])('preserves unqualified write refusal for %s', (write) => {
    const code = `${DECLARE}${write}exports.version=host.process.version;`;
    const visits = visitTree(program(code)).map((visit) => completeVisit(visit));

    expect(analyzeAssignedNodeHosts(visits).assigned.size).toBe(0);
    expect(assignedNodeHosts(visits).size).toBe(0);
    expect(dynamicNodeClosureRefusal(FILE, code)).toBeTypeOf('string');
  });

  it('keeps own shadowed globalThis writes ordinary', () => {
    const code = `${DECLARE}function local(globalThis){globalThis.memo=42;}exports.local=local;exports.version=host.process.version;`;
    const visits = visitTree(program(code)).map((visit) => completeVisit(visit));

    expect(analyzeAssignedNodeHosts(visits).assigned.size).toBe(2);
    expect(dynamicNodeClosureRefusal(FILE, code)).toBeUndefined();
  });

  it('does not treat a caller-created loader proof as metadata write authority', () => {
    const code = `globalThis.memo=42;${DECLARE}exports.version=host.process.version;`;
    const forged = {} as NodeNextCacheWriteProof;

    expect(() =>
      dynamicNodeClosureRefusal(FILE, code, undefined, { nextCacheWrite: forged }),
    ).toThrow('copied or missing proof');
  });
});
