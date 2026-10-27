import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { isNode } from '../src/lexical-scope.ts';
import { assignedNodeHosts, hostObjectOf } from '../src/node-closure-hosts.ts';
import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';
import { visitTree } from '../src/node-manifest-consumer-ast.ts';

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

describe('original assignment host provenance with authored AST only', () => {
  it.each([
    [
      'lowered optional process metadata',
      `var host;const {env,stdout}=(${OPTIONAL_PROCESS})??{};exports.enabled=env&&stdout;`,
    ],
    ['standalone assignment', `${DECLARE}exports.version=host.process.version;`],
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
});
