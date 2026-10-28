import { createHash } from 'node:crypto';

import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { isNode, listOf, type Node } from '../src/lexical-scope.ts';
import {
  identifier,
  propertyName,
  stringOf,
  visitTree,
} from '../src/node-manifest-consumer-ast.ts';
import { projectedTemplateExports } from '../src/node-manifest-template-exports.ts';
import {
  assertNodeManifestTurbopackTemplateConsumer,
  type NodeManifestTurbopackTemplateInput,
} from '../src/node-manifest-turbopack-templates.ts';
import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';
import {
  projectedTemplateFixture,
  reprojectTemplateFixture,
} from './fixtures/node-manifest-turbopack-template.ts';

function source(body: string, ids = '1') {
  const code = `module.exports=[${ids},ctx=>{${body}}];`;
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}

function project(body: string) {
  return projectNodeManifestTurbopackFactory(source(body), 1);
}

function parsedNodes(code: string): readonly Node[] {
  const program: unknown = parseAst(code);
  if (!isNode(program)) throw new TypeError('Expected an inert inspection program');
  return visitTree(program).map((visit) => visit.node);
}

function capture(nodes: readonly Node[], name: string): Node {
  const found = nodes.find((node) => {
    const value = node['init'];
    return node.type === 'VariableDeclarator' && identifier(value) && value.name === name;
  });
  if (found === undefined) throw new TypeError('Expected the selected export capture');
  return found;
}

function mutation(nodes: readonly Node[], name: string): Node {
  const found = nodes.find((node) => {
    const value = node['left'];
    return node.type === 'AssignmentExpression' && identifier(value) && value.name === name;
  });
  if (found === undefined) throw new TypeError('Expected the authored binding mutation');
  return found;
}

function memberCapture(nodes: readonly Node[], object: string, key: string): Node {
  const found = nodes.find((node) => {
    const value = node['init'];
    return (
      node.type === 'VariableDeclarator' &&
      isNode(value) &&
      value.type === 'MemberExpression' &&
      identifier(value['object']) &&
      value['object'].name === object &&
      propertyName(value) === key
    );
  });
  if (found === undefined) throw new TypeError('Expected the direct member capture');
  return found;
}

function directRegistration(
  code: string,
  nodes: readonly Node[],
): { start: number; end: number; text: string } {
  const call = nodes.find((node) => {
    const callee = node['callee'];
    return node.type === 'CallExpression' && isNode(callee) && propertyName(callee) === 's';
  });
  const statement = nodes.find((node) => node['expression'] === call);
  const table = call === undefined ? undefined : listOf(call, 'arguments')[0];
  if (call === undefined || statement === undefined || !isNode(table))
    throw new TypeError('Expected the primary fixture export registration');
  const entries = listOf(table, 'elements');
  const fields: string[] = [];
  for (let index = 0; index < entries.length; index += 2) {
    const name = stringOf(entries[index]);
    const getter = entries[index + 1];
    const value = isNode(getter) ? getter['body'] : undefined;
    if (name === undefined || !isNode(value)) throw new TypeError('Expected a fixture getter');
    fields.push(`${jsLiteral(name)},0,${code.slice(value.start, value.end)}`);
  }
  return {
    start: statement.start,
    end: statement.end,
    text: `runtimeContext.s([${fields.join(',')}]);`,
  };
}

function scaffold(code: string) {
  const program: unknown = parseAst(code);
  if (!isNode(program)) throw new TypeError('Expected an inert selector scaffold');
  return projectedTemplateExports(program);
}

function eagerTemplateCode(own: NodeManifestTurbopackTemplateInput): string {
  const code = own.projection.original.code;
  const nodes = parsedNodes(code);
  const registration = directRegistration(code, nodes);
  const factory = nodes.find(
    (node) =>
      node.start === own.projection.factory.start && node.end === own.projection.factory.end,
  );
  const body = factory?.['body'];
  if (!isNode(body)) throw new TypeError('Expected the selected primary fixture factory');
  return (
    code.slice(0, registration.start) +
    code.slice(registration.end, body.end - 1) +
    registration.text +
    code.slice(body.end - 1)
  );
}

describe('fixed Turbopack EsmBindings direct values', () => {
  it.each([
    'const handler=entry.handler;ctx.s(["handler",0,handler]);',
    'ctx.s(["handler",0,entry.handler]);',
    'ctx.s(["handler",()=>entry.handler,"routeModule",0,entry.routeModule]);',
  ])('preserves finite direct selectors beside existing getter bindings: %s', (body) => {
    const original = source(body);
    const projected = project(body);

    expect(projected.original).toStrictEqual(original);
    expect(projected.exports.kind).toBe('getters');
    expect(projected.imports).toStrictEqual([]);
    expect(projected.boundRuntimeInputs).toStrictEqual([]);
    expect(() => parseAst(projected.source.code)).not.toThrow();
  });

  it('captures direct values at registration before a later mutation', () => {
    const body = 'let local=first;ctx.s(["value",0,local]);local=other;';
    const projected = project(body);
    const nodes = parsedNodes(projected.source.code);
    const saved = capture(nodes, 'local');

    expect(saved.start).toBeLessThan(mutation(nodes, 'local').start);
    expect(projected.original).toStrictEqual(source(body));
    expect(projected.source.code).toContain('local=other;');
  });

  it('retains direct evaluation order while leaving getter reads late', () => {
    const body =
      'let eager=first;let late=initial;ctx.s(["first",0,eager,"middle",()=>late,"last",0,state.value]);eager=other;late=updated;';
    const projected = project(body);
    const nodes = parsedNodes(projected.source.code);
    const eager = capture(nodes, 'eager');
    const member = memberCapture(nodes, 'state', 'value');

    expect(eager.start).toBeLessThan(member.start);
    expect(member.start).toBeLessThan(mutation(nodes, 'eager').start);
    expect(capture(nodes, 'late').start).toBeGreaterThan(mutation(nodes, 'late').start);
    expect(projected.exports).toStrictEqual({
      kind: 'getters',
      names: ['first', 'middle', 'last'],
    });
    expect(projected.original).toStrictEqual(source(body));
  });

  it('certifies a primary-derived Pages template with eager selected exports after declarations', async () => {
    const own = await projectedTemplateFixture('pages');
    const changed = eagerTemplateCode(own);
    const input = reprojectTemplateFixture(own, changed);
    const proof = await assertNodeManifestTurbopackTemplateConsumer(input);

    expect(proof.kind).toBe('pages');
    expect(proof.exports).toContain('handler');
    expect(proof.exports).toContain('routeModule');
    expect(proof.requiresRuntimeNormalization).toBe(true);
    expect(input.projection.original.code).toBe(changed);
    expect(input.imports).toStrictEqual(own.imports);
  });

  it('keeps literal registration IDs and their export identities distinct', () => {
    const original = source('ctx.s(["numeric",0,numeric],1);ctx.s(["text",0,text],"1");', '1,"1"');
    const numeric = projectNodeManifestTurbopackFactory(original, 1);
    const text = projectNodeManifestTurbopackFactory(original, '1');

    expect(numeric.exports).toStrictEqual({ kind: 'getters', names: ['numeric'] });
    expect(text.exports).toStrictEqual({ kind: 'getters', names: ['text'] });
    expect(numeric.source.code).toContain('ctx.s(["text",0,text],"1")');
    expect(text.source.code).toContain('ctx.s(["numeric",0,numeric],1)');
  });

  it.each([
    'ctx.s(["value",0]);',
    'ctx.s(["value",0,value,"dangling"]);',
    'ctx.s(["value",0,value,"value",()=>value]);',
    'ctx.s(["value",1,value]);',
    'ctx.s(["value","0",value]);',
    'ctx.s(["value",0n,value]);',
    'ctx.s(["value",null,value]);',
    'ctx.s(["value",/literal/,value]);',
    'ctx.s(["value",0,,]);',
    'ctx.s(["value",0,...values]);',
    'ctx.s(["value",0,()=>value]);',
    'ctx.s(["value",0,function(){return value;}]);',
    'ctx.s(["value",0,42]);',
    'ctx.s(["value",0,calculate()]);',
    'ctx.s(["value",0,state[key]]);',
    'ctx.s(["value",0,arguments]);',
    'ctx.s(["value",0,ctx]);',
    'ctx.s(["value",()=>value,next=>value=next]);',
    'ctx.s(["value",0,value,next=>value=next]);',
    'ctx.s(["value",0,value],2);',
    'ctx.s(["value",0,value],null,true);',
    'if(flag)ctx.s(["value",0,value]);',
  ])('refuses setters, malformed records, open values or unsupported targets: %s', (body) => {
    expect(() => project(body)).toThrow('Unproved Next.js');
  });
});

describe('recomputed projector selector scaffolds', () => {
  const CAPTURE = '__upwind_turbopack_getter_1';
  const DECLARATION = `const ${CAPTURE}=value;`;
  const EXPORT = `export {${CAPTURE} as "value"};`;

  it('pairs only the same generated lexical capture across ordinary body statements', () => {
    const selected = scaffold(`${DECLARATION}value=other;${EXPORT}`);

    expect([...selected.fields.keys()]).toStrictEqual(['value']);
    expect(selected.body).toHaveLength(1);
  });

  it.each([
    DECLARATION,
    EXPORT,
    `let ${CAPTURE}=value;${EXPORT}`,
    `const ${CAPTURE}=value,extra=other;${EXPORT}`,
    `${DECLARATION}${EXPORT}export {${CAPTURE} as "other"};`,
    `${DECLARATION}consume(${CAPTURE});${EXPORT}`,
    `${DECLARATION}${CAPTURE}=other;${EXPORT}`,
    `${DECLARATION}function local(${CAPTURE}){return ${CAPTURE};}${EXPORT}`,
    `${DECLARATION}{const ${CAPTURE}=other;}${EXPORT}`,
    `${DECLARATION}export {unknown as "value"};`,
    `${DECLARATION}export {${CAPTURE} as "value"} from "other";`,
  ])('refuses missing, duplicate, rebound, shadowed or escaped capture authority: %s', (code) => {
    expect(() => scaffold(code)).toThrow('Unproved Next.js');
  });
});
