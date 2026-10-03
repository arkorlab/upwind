import type { Argument, Node, Program } from '@oxc-project/types';
import type { OutputChunk } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';

/**
 * The uses of the loader the bundler could not follow, found in each module as Rolldown
 * rendered it into the chunk — after it followed what it could.
 *
 * In the rendered module, a `require` of a module bundled has become a call of that module's
 * function, one of a Node built-in a `require` of its name, and every `require` left with a
 * name of its own is the Function's: Rolldown reserves the name for it and renames any binding a
 * module called `require` out of its way — a parameter, say — so the call of such a binding is
 * not mistaken for a load. What is left of the name is what the Function will do with the loader
 * at run time, against modules it does not have, and that is what is reported: a call of it
 * with anything but one module's name, whatever the spelling was (`(0, require)(name)` is
 * rendered `require(name)`); a method of it called — `require.resolve`, which resolves, and
 * `require.call` or `require.apply`, which load — or kept, as `require.bind` or the resolver
 * taken as a value; and the loader itself kept — assigned to a name, passed on, returned,
 * stored — for a call the record cannot see, through the name it was given. A look at the
 * loader (`typeof require`) and a property read off it that resolves nothing (`require.main`,
 * `require.cache`) are not. A module object's own loader — `module.require`, and the main
 * module's through `require.main` or `process.mainModule` — is reported called with any
 * argument, and kept: the object a module gets in the bundle has no loader on it, so the call
 * throws where the file it was written in would have loaded. An `import()` of anything but one
 * module's name is a load the bundler could not follow too. A module the chunk does not carry
 * is not looked at.
 *
 * A use is *guarded* where the code handles its failure itself: a call of the loader, or of a
 * method of it, in the block of a `try` that has a `catch`, within the same function — an
 * `import()` too, where it is awaited there. Such a load fails in the Function as it fails under
 * Node.js when the module is not installed, into the code's own `catch`: `@protobufjs/inquire`,
 * which every `protobufjs` loads its optional modules through, and TypeScript's `sys.require`,
 * which loads a compiler plugin, are written that way. Not across a function's boundary: a `try`
 * around a function's definition catches nothing its later calls throw.
 */

/** A use of the loader the bundler could not follow, in the module that makes it. */
export interface DynamicLoad {
  readonly file: string;
  /**
   * The line of the use in the module as Rolldown rendered it into the chunk — its statements
   * as Rolldown printed them, which is not the file's own layout.
   */
  readonly line: number;
  /** The call, or the assignment or statement that keeps the loader. */
  readonly text: string;
  /** Whether the code handles the load's failure itself (see above). */
  readonly guarded: boolean;
}

/** As much of a use as the record shows. */
const DYNAMIC_LOAD_TEXT = 80;

/** A node on the way down: the visit it is under, by which field, and the statement it is in. */
interface Visit {
  readonly node: Node;
  readonly up: Visit | undefined;
  readonly key: string | undefined;
  readonly statement: Node;
}

/** What a use of the loader is reported by. */
interface Use {
  readonly node: Node;
  readonly text: Node;
  readonly guarded: boolean;
}

/**
 * Whether a load's argument names one module: a string, or a template with nothing to fill in.
 * Anything else — a name, a call, a string with something added to it, nothing at all — is
 * resolved at run time, against modules the Function does not have, or throws there.
 */
function namesOneModule(argument: Argument | undefined): boolean {
  if (argument === undefined) {
    return false;
  }
  if (argument.type === 'Literal') {
    return typeof argument.value === 'string';
  }
  return argument.type === 'TemplateLiteral' && argument.expressions.length === 0;
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function isStatement(node: Node): boolean {
  return node.type.endsWith('Statement') || node.type.endsWith('Declaration');
}

/** Where an identifier names a member, a key or a label, whatever its field, not a binding. */
const NAMING_PARENTS: ReadonlySet<string> = new Set([
  'BreakStatement',
  'ContinueStatement',
  'LabeledStatement',
  'MethodDefinition',
  'PropertyDefinition',
]);

/** Whether the identifier is a reference to what its name is bound to, rather than a name. */
function isReference(parent: Node, key: string | undefined): boolean {
  if (key === 'property' && parent.type === 'MemberExpression') {
    return parent.computed;
  }
  if (key === 'key' && parent.type === 'Property') {
    return parent.computed;
  }
  return !NAMING_PARENTS.has(parent.type);
}

/**
 * The properties of the loader that resolve nothing, read or kept: Node's own `main`, `cache`
 * and `extensions`, and a function's. Every other — `resolve`, `call`, `apply`, `bind`, one
 * named at run time — resolves or loads when called, and keeps the loader when kept.
 */
const PASSIVE_PROPERTIES: ReadonlySet<string> = new Set([
  'cache',
  'extensions',
  'length',
  'main',
  'name',
  'toString',
]);

/** Whether `member`, read off the loader, is one of the properties that resolve nothing. */
function isPassive(member: Node): boolean {
  return (
    member.type === 'MemberExpression' &&
    !member.computed &&
    member.property.type === 'Identifier' &&
    PASSIVE_PROPERTIES.has(member.property.name)
  );
}

/** Whether `node` is a module object: `module`, or the main one through `require` or `process`. */
function isModuleObject(node: Node): boolean {
  if (node.type === 'Identifier') {
    return node.name === 'module';
  }
  if (node.type !== 'MemberExpression' || node.computed) {
    return false;
  }
  const { object, property } = node;
  if (object.type !== 'Identifier' || property.type !== 'Identifier') {
    return false;
  }
  return (
    (object.name === 'require' && property.name === 'main') ||
    (object.name === 'process' && property.name === 'mainModule')
  );
}

/**
 * What keeps the loader, as the record shows it: the assignment it is part of, and the whole
 * statement where it is part of none. A minified module is one comma expression per statement, in
 * which the statement names every other thing done alongside and the assignment names this one.
 */
function keeperOf(visit: Visit): Node {
  for (let up: Visit | undefined = visit; up !== undefined; up = up.up) {
    if (up.node.type === 'AssignmentExpression') {
      return up.node;
    }
    if (isStatement(up.node)) {
      break;
    }
  }
  return visit.statement;
}

/** Where a function begins: a `try` outside it catches nothing a later call of it throws. */
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);

/**
 * Whether what `visit` is part of runs in the block of a `try` that has a `catch`, without a
 * function's boundary between them. A `try` whose `catch` or `finally` it is in does not count;
 * one around that may.
 */
function inGuardedBlock(visit: Visit): boolean {
  let at = visit;
  while (at.up !== undefined) {
    const { node } = at.up;
    if (FUNCTION_TYPES.has(node.type)) {
      return false;
    }
    if (node.type === 'TryStatement' && at.key === 'block' && node.handler !== null) {
      return true;
    }
    at = at.up;
  }
  return false;
}

/** A use that fails where it is made, into a `catch` around it: a call, made in a guarded block. */
function guardedCall(visit: Visit, call: Node): boolean {
  return call.type === 'CallExpression' && inGuardedBlock(visit);
}

/** A method called is reported as the call; one kept, as what keeps it. */
function methodUse(visit: Visit, member: Node): Use {
  const above = visit.up?.node;
  const called = visit.key === 'callee' && above?.type === 'CallExpression';
  return called
    ? { node: above, text: above, guarded: guardedCall(visit, above) }
    : { node: member, text: keeperOf(visit), guarded: false };
}

/**
 * The use a module object's loader is — `module.require`, named as the property of the
 * object — or `undefined` where the property is another object's.
 */
function useOfModuleLoader(visit: Visit): Use | undefined {
  const { up, key } = visit;
  if (up === undefined || key !== 'property') {
    return undefined;
  }
  const member = up.node;
  if (member.type !== 'MemberExpression' || member.computed || !isModuleObject(member.object)) {
    return undefined;
  }
  return methodUse(up, member);
}

/** The use of the loader a reference to it is, or `undefined` for one that resolves nothing. */
function useOfLoader(visit: Visit): Use | undefined {
  const { node, up, key } = visit;
  if (up === undefined || !isReference(up.node, key)) {
    return undefined;
  }
  const parent = up.node;
  if (key === 'callee' && parent.type === 'CallExpression') {
    return namesOneModule(parent.arguments[0])
      ? undefined
      : { node: parent, text: parent, guarded: guardedCall(visit, parent) };
  }
  if (parent.type === 'UnaryExpression' && parent.operator === 'typeof') {
    return undefined;
  }
  if (key === 'object' && parent.type === 'MemberExpression') {
    return isPassive(parent) ? undefined : methodUse(up, parent);
  }
  return { node, text: keeperOf(visit), guarded: false };
}

/** A use of the loader, of a module object's, or an `import()`, that `visit` is. */
function useAt(visit: Visit): Use | undefined {
  const { node } = visit;
  if (node.type === 'ImportExpression') {
    // Its failure is a rejection, which a `try` sees only where it is awaited in the block.
    const awaited = visit.up?.node.type === 'AwaitExpression';
    return namesOneModule(node.source)
      ? undefined
      : { node, text: node, guarded: awaited && inGuardedBlock(visit.up) };
  }
  if (node.type !== 'Identifier' || node.name !== 'require') {
    return undefined;
  }
  return useOfModuleLoader(visit) ?? useOfLoader(visit);
}

/** Put every node under `visit` — each field that is one, or a list of them — on `pending`. */
function pushChildren(visit: Visit, pending: Visit[]): void {
  const { node } = visit;
  const statement = isStatement(node) ? node : visit.statement;
  for (const [key, value] of Object.entries(node)) {
    // A parent link, when the parser adds one, would lead back up.
    if (key === 'parent') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          pending.push({ node: item, up: visit, key, statement });
        }
      }
    } else if (isNode(value)) {
      pending.push({ node: value, up: visit, key, statement });
    }
  }
}

/**
 * The uses of the loader in `program` the bundler could not follow, in source order. Walked
 * with a stack of its own: a module of Next.js's runtime is megabytes of syntax, and a
 * recursion — a generator's above all — costs each node its depth.
 */
function usesIn(program: Program): Use[] {
  const found: Use[] = [];
  const pending: Visit[] = [{ node: program, up: undefined, key: undefined, statement: program }];
  for (let visit = pending.pop(); visit !== undefined; visit = pending.pop()) {
    const use = useAt(visit);
    if (use !== undefined) {
      found.push(use);
    }
    pushChildren(visit, pending);
  }
  return found.toSorted((a, b) => a.node.start - b.node.start);
}

/** A use as the record takes it: where it is, and as much of the text as the record shows. */
function describe(file: string, code: string, use: Use): DynamicLoad {
  const { start } = use.text;
  return {
    file,
    line: code.slice(0, use.node.start).split('\n').length,
    text: code.slice(start, Math.min(use.text.end, start + DYNAMIC_LOAD_TEXT)),
    guarded: use.guarded,
  };
}

/** The uses in one module as rendered; JavaScript by then, whatever the module was written in. */
function dynamicLoadsOf(file: string, code: string): DynamicLoad[] {
  return usesIn(parseAst(code, { lang: 'js' }, file)).map((use) => describe(file, code, use));
}

/** Every use of the loader the bundler could not follow, in every module rendered into `chunk`. */
export function dynamicLoadsInChunk(chunk: OutputChunk): DynamicLoad[] {
  return Object.entries(chunk.modules).flatMap(([file, module]) =>
    module.code === null ? [] : dynamicLoadsOf(file, module.code),
  );
}
