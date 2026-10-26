import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { isNode, type Node } from '../src/lexical-scope.ts';
import { nodeManifestCoalescedPagesInspection } from '../src/node-manifest-coalesced-pages.ts';
import { identifier, visitTree } from '../src/node-manifest-consumer-ast.ts';
import { assertNodeManifestPagesEsmPorts } from '../src/node-manifest-pages-esm-ports.ts';
import { proveNodeManifestTurbopackConsumers } from '../src/node-manifest-turbopack-consumers.ts';
import { assertNodeManifestTurbopackTemplateConsumer } from '../src/node-manifest-turbopack-templates.ts';
import { coalescedPagesEsmFixture } from './fixtures/node-manifest-coalesced-pages-esm.ts';

function variable(program: Node, name: string): Node {
  const own = visitTree(program).find(
    ({ node }) =>
      node.type === 'VariableDeclarator' && identifier(node['id']) && node['id'].name === name,
  )?.node;
  if (own === undefined) throw new TypeError('Expected the authored declaration');
  return own;
}
function coalesced(input: Awaited<ReturnType<typeof inspected>>) {
  const context = input.original.coalesced;
  if (context === undefined) throw new TypeError('Expected the private profile');
  return context;
}
async function inspected() {
  const fixture = await coalescedPagesEsmFixture();
  const context = fixture.template.coalesced;
  if (context === undefined) throw new TypeError('Expected a real private coalesced profile');
  const view = nodeManifestCoalescedPagesInspection(
    context.profile,
    context.owner,
    fixture.template.projection,
    { ...fixture.template.route, kind: 'pages' },
  );
  const program: unknown = parseAst(view.projection.source.code);
  if (!isNode(program)) throw new TypeError('Expected the inert derived program');
  const slots = new Map<Node, string>();
  const roles = new Map([
    ['app', 'VAR_MODULE_APP'],
    ['document', 'VAR_MODULE_DOCUMENT'],
    ['userland', 'VAR_USERLAND'],
  ]);
  for (const { node } of visitTree(program)) {
    const id = node['id'];
    if (node.type !== 'VariableDeclarator' || !identifier(id)) continue;
    const role = roles.get(id.name);
    if (role !== undefined) slots.set(node, role);
  }
  return { original: fixture.template, program, slots, namespace: view.namespace };
}

describe('private coalesced namespace alias in the fixed Pages ESM template', () => {
  it.each(['var', 'let', 'const'] as const)(
    'closes the whole protected %s wrapper with one certified namespace role',
    async (kind) => {
      const fixture = await coalescedPagesEsmFixture({ kind });
      const original = fixture.factory.projection.original;

      await expect(
        assertNodeManifestTurbopackTemplateConsumer(fixture.template),
      ).resolves.toMatchObject({
        kind: 'pages',
        requiresRuntimeNormalization: true,
      });

      const proof = await proveNodeManifestTurbopackConsumers(fixture.input);

      expect(proof.terminals).toHaveLength(1);
      expect(proof.requiresSdkNormalization).toBe(true);
      expect(fixture.factory.projection.original).toBe(original);
      expect(proof.compilerSources.some((file) => file.file === fixture.factory.physicalId)).toBe(
        false,
      );
    },
  );

  it('refuses duplicate role metadata rather than counting the alias twice', async () => {
    const input = await inspected();
    const other = variable(input.program, 'handlerNs');
    input.slots.set(other, 'VAR_USERLAND');

    expect(() => {
      assertNodeManifestPagesEsmPorts(input);
    }).toThrow('duplicate namespace');
  });

  it.each(['userland={};', 'userland.default=()=>null;', 'var second=context.i(42);'])(
    'refuses an original mutated or duplicate namespace alias %s',
    async (afterRead) => {
      const fixture = await coalescedPagesEsmFixture({ afterRead });

      await expect(assertNodeManifestTurbopackTemplateConsumer(fixture.template)).rejects.toThrow(
        'refusing native publication',
      );
    },
  );

  it('still refuses an original raw require cache read', async () => {
    const fixture = await coalescedPagesEsmFixture({ namespaceMethod: 'r' });

    await expect(assertNodeManifestTurbopackTemplateConsumer(fixture.template)).rejects.toThrow(
      'unique namespace read',
    );
  });

  it('refuses changing the derived alias after certification', async () => {
    const input = await inspected();
    const alias = variable(input.program, 'userland');
    Reflect.set(alias, 'init', { ...(alias['init'] as Node), name: 'otherNamespace' });

    expect(() => {
      assertNodeManifestPagesEsmPorts(input);
    }).toThrow('changed coalesced namespace view');
  });

  it('refuses a name-only namespace claim without the original private profile', async () => {
    const input = await inspected();
    const original = { ...input.original };
    delete original.coalesced;

    expect(() => {
      assertNodeManifestPagesEsmPorts({ ...input, original });
    }).toThrow('uncertified coalesced namespace');
  });

  it('refuses a copied private profile and a changed owner', async () => {
    const input = await inspected();
    const context = coalesced(input);
    for (const changed of [
      { ...context, profile: { ...context.profile } },
      { ...context, owner: { ...context.owner } },
    ])
      expect(() => {
        assertNodeManifestPagesEsmPorts({
          ...input,
          original: { ...input.original, coalesced: changed },
        });
      }).toThrow('copied, stale or cross-batch identity');
  });
});
