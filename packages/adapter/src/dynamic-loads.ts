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
 * method of it that loads, in the block of a `try` whose `catch` and `finally` let nothing out —
 * no `throw` or `Promise.reject(…)` that runs when they do, outside a `try` of their own that
 * catches it — and an `import()` too, where it, or a promise chained from it, is awaited there. Such a load fails in the Function as it fails under
 * Node.js when the module is not installed, into the code's own `catch`: `@protobufjs/inquire`,
 * which every `protobufjs` loads its optional modules through, and TypeScript's `sys.require`,
 * which loads a compiler plugin, are written that way. Not across code that runs later — a
 * function's body, unless the function is neither `async` nor a generator and is called where it
 * is made, and an instance field's initializer or a constructor, unless the class is constructed
 * where it is made: a `try` around their definition catches nothing they throw when they run —
 * and never `require.bind`, which makes a loader rather than loading. What a `catch` or a
 * `finally` calls is taken not to throw: a function called by its name is not followed.
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

/** The name of the property `member` reads, where the code spells it: `a.name` or `a['name']`. */
function propertyName(member: Node): string | undefined {
  if (member.type !== 'MemberExpression') {
    return undefined;
  }
  const { property } = member;
  if (!member.computed) {
    return property.type === 'Identifier' ? property.name : undefined;
  }
  return property.type === 'Literal' && typeof property.value === 'string'
    ? property.value
    : undefined;
}

/** Whether `member`, read off the loader, is one of the properties that resolve nothing. */
function isPassive(member: Node): boolean {
  const name = propertyName(member);
  return name !== undefined && PASSIVE_PROPERTIES.has(name);
}

/** Whether `node` is a module object: `module`, or the main one through `require` or `process`. */
function isModuleObject(node: Node): boolean {
  if (node.type === 'Identifier') {
    return node.name === 'module';
  }
  if (node.type !== 'MemberExpression' || node.object.type !== 'Identifier') {
    return false;
  }
  const { name } = node.object;
  const property = propertyName(node);
  return (
    (name === 'require' && property === 'main') || (name === 'process' && property === 'mainModule')
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

/** A function's body runs when the function is called, which is later unless it is called at once. */
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);

/** The methods of a function that call it: `(function () { … }).call(this)` runs it at once. */
const CALLING_METHODS: ReadonlySet<string> = new Set(['apply', 'call']);

/**
 * `node` as the value it stands for: out of the parentheses around it, where the parser keeps them,
 * and the last of a sequence — `(0, function () { … })()` calls the function.
 */
function unwrapped(node: Node): Node {
  let at = node;
  for (let inner = innerOf(at); inner !== undefined; inner = innerOf(at)) {
    at = inner;
  }
  return at;
}

/** What `node` evaluates to, where it is a wrapper: the parenthesized, the last of a sequence. */
function innerOf(node: Node): Node | undefined {
  if (node.type === 'ParenthesizedExpression') {
    return node.expression;
  }
  return node.type === 'SequenceExpression' ? node.expressions.at(-1) : undefined;
}

/**
 * The function `call` runs where it is made — `(() => { … })()`, or through its `call` or
 * `apply` — or `undefined`. Not an `async` function or a generator: what an `async` one throws is a
 * rejection, and a generator's body has not run when the call returns.
 */
function calledAtOnce(call: Node): Node | undefined {
  if (call.type !== 'CallExpression') {
    return undefined;
  }
  let callee = unwrapped(call.callee);
  if (callee.type === 'MemberExpression') {
    const name = propertyName(callee);
    if (name === undefined || !CALLING_METHODS.has(name)) {
      return undefined;
    }
    callee = unwrapped(callee.object);
  }
  if (callee.type !== 'ArrowFunctionExpression' && callee.type !== 'FunctionExpression') {
    return undefined;
  }
  return callee.async || callee.generator ? undefined : callee;
}

/** What a call may reach its function through: parentheses, a sequence, a `call` or `apply`. */
const WRAPPING_TYPES: ReadonlySet<string> = new Set([
  'MemberExpression',
  'ParenthesizedExpression',
  'SequenceExpression',
]);

/** The call above `visit` — through what may wrap the function it calls — that may run it. */
function callAbove(visit: Visit): Node | undefined {
  let at = visit.up;
  while (at !== undefined && WRAPPING_TYPES.has(at.node.type)) {
    at = at.up;
  }
  return at?.node;
}

/** The class `node` constructs where it is made — `new (class { … })()` — or `undefined`. */
function constructedAtOnce(node: Node): Node | undefined {
  if (node.type !== 'NewExpression') {
    return undefined;
  }
  const callee = unwrapped(node.callee);
  return callee.type === 'ClassExpression' ? callee : undefined;
}

/** Whether `member`, a member of a class, is one of a class constructed where it is made. */
function ofClassConstructedAtOnce(member: Visit): boolean {
  const made = member.up?.up;
  if (made === undefined) {
    return false;
  }
  let at: Visit | undefined = made.up;
  while (at?.node.type === 'ParenthesizedExpression') {
    at = at.up;
  }
  return at !== undefined && constructedAtOnce(at.node) === made.node;
}

/** Whether `fn`, a function's visit, is a class's constructor: what constructing the class runs. */
function isConstructor(fn: Visit): boolean {
  const method = fn.up?.node;
  return method?.type === 'MethodDefinition' && method.kind === 'constructor' && fn.key === 'value';
}

/**
 * Whether the code under `parent`, by its field `key`, runs later than the code around `parent`:
 * a function's, unless it is called at once, and an instance field's initializer, which runs when
 * an instance is made — both at once for a class constructed where it is made. A static field's
 * runs as the class is made, and so does a computed key.
 */
function runsLater(parent: Visit, key: string | undefined): boolean {
  const { node } = parent;
  if (FUNCTION_TYPES.has(node.type)) {
    const call = callAbove(parent);
    const atOnce =
      (call !== undefined && calledAtOnce(call) === node) ||
      (isConstructor(parent) && parent.up !== undefined && ofClassConstructedAtOnce(parent.up));
    return !atOnce;
  }
  if (node.type === 'PropertyDefinition' || node.type === 'AccessorProperty') {
    return !node.static && key === 'value' && !ofClassConstructedAtOnce(parent);
  }
  return false;
}

/** The nodes directly under `node`: each field that is one, or a list of them. */
function childrenOf(node: Node): Node[] {
  const children: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    // A parent link, when the parser adds one, would lead back up.
    if (key === 'parent') {
      continue;
    }
    const values: unknown[] = Array.isArray(value) ? value : [value];
    children.push(...values.filter((child) => isNode(child)));
  }
  return children;
}

/** What constructing `made`, a class, runs of it: its instance fields' initializers and constructor. */
function constructionOf(made: Node): Node[] {
  if (made.type !== 'ClassExpression') {
    return [];
  }
  return made.body.body.flatMap((member): Node[] => {
    if (member.type === 'MethodDefinition') {
      return member.kind === 'constructor' ? childrenOf(member.value) : [];
    }
    if (member.type !== 'PropertyDefinition' && member.type !== 'AccessorProperty') {
      return [];
    }
    return member.static || member.value === null ? [] : [member.value];
  });
}

/**
 * The nodes under `node` that run when it runs and may throw out of it. Not a function's body, nor
 * an instance field's initializer (`runsLater`) — but the body of a function a call runs at once,
 * and what constructing a class constructed at once runs — and not the block of a `try` with a
 * `catch`, which catches what it throws.
 */
function throwingChildrenOf(node: Node): Node[] {
  if (FUNCTION_TYPES.has(node.type)) {
    return [];
  }
  if (node.type === 'PropertyDefinition' || node.type === 'AccessorProperty') {
    return node.static ? childrenOf(node) : [node.key];
  }
  if (node.type === 'TryStatement' && node.handler !== null) {
    return node.finalizer === null ? [node.handler] : [node.handler, node.finalizer];
  }
  const called = calledAtOnce(node) ?? constructedAtOnce(node);
  if (called === undefined) {
    return childrenOf(node);
  }
  const ran = called.type === 'ClassExpression' ? constructionOf(called) : childrenOf(called);
  return [...childrenOf(node), ...ran];
}

/**
 * Whether running `node` may let a failure out of it (`letsFailureOut`), among what it runs and
 * outside a `try` of its own.
 */
function throwsOut(node: Node | null): boolean {
  const pending: Node[] = node === null ? [] : [node];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (letsFailureOut(at)) {
      return true;
    }
    pending.push(...throwingChildrenOf(at));
  }
  return false;
}

/**
 * Whether `node` lets a failure out of the code it is in: a `throw`, and a `Promise.reject(…)`,
 * which is how a function that answers with a promise throws.
 */
function letsFailureOut(node: Node): boolean {
  if (node.type === 'ThrowStatement') {
    return true;
  }
  if (node.type !== 'CallExpression') {
    return false;
  }
  const callee = unwrapped(node.callee);
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Promise' &&
    propertyName(callee) === 'reject'
  );
}

/**
 * Whether a `try` keeps in the failure of what its block runs: it has a `catch`, and neither that
 * nor its `finally` throws out. One that throws — the same error, another made of it, or what the
 * `catch` put aside, thrown again by the `finally` — lets the load's failure out as surely as no
 * `catch` at all.
 */
function keepsFailureIn(statement: Node): boolean {
  return (
    statement.type === 'TryStatement' &&
    statement.handler !== null &&
    !throwsOut(statement.handler) &&
    !throwsOut(statement.finalizer)
  );
}

/**
 * Whether what `visit` is part of runs in the block of a `try` whose `catch` keeps the failure in,
 * with nothing that runs later between them. A `try` whose `catch` or `finally` it is in does not
 * count; one around that may.
 */
function inGuardedBlock(visit: Visit): boolean {
  for (let at = visit; at.up !== undefined; at = at.up) {
    if (runsLater(at.up, at.key)) {
      return false;
    }
    if (at.key === 'block' && keepsFailureIn(at.up.node)) {
      return true;
    }
  }
  return false;
}

/** A use that fails where it is made, into a `catch` around it: a call, made in a guarded block. */
function guardedCall(visit: Visit, call: Node): boolean {
  return call.type === 'CallExpression' && inGuardedBlock(visit);
}

/**
 * The loader's methods that load or resolve when they are called — and a module object's own
 * `require`. `bind` is not one: it makes a loader for a call the record cannot see, and is kept.
 */
const LOADING_METHODS: ReadonlySet<string> = new Set(['apply', 'call', 'require', 'resolve']);

function loadsWhenCalled(member: Node): boolean {
  const name = propertyName(member);
  return name !== undefined && LOADING_METHODS.has(name);
}

/** A method called is reported as the call; one kept, as what keeps it. */
function methodUse(visit: Visit, member: Node): Use {
  const above = visit.up?.node;
  const called = visit.key === 'callee' && above?.type === 'CallExpression';
  return called
    ? { node: above, text: above, guarded: loadsWhenCalled(member) && guardedCall(visit, above) }
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

/** A promise's methods: each passes a rejection on to the promise it makes, or handles it. */
const PROMISE_METHODS: ReadonlySet<string> = new Set(['catch', 'finally', 'then']);

/** What carries on the promise `at` makes: the parentheses around it, or a call of its method. */
function chainedFrom(at: Visit): Visit | undefined {
  const { up } = at;
  if (up === undefined) {
    return undefined;
  }
  if (up.node.type === 'ParenthesizedExpression') {
    return up;
  }
  const name = propertyName(up.node);
  const method = at.key === 'object' && name !== undefined && PROMISE_METHODS.has(name);
  return method && up.key === 'callee' && up.up?.node.type === 'CallExpression' ? up.up : undefined;
}

/**
 * The `await` of the promise `visit` makes, or of one chained from it — `import(name).then(use)` —
 * or `undefined` where nothing awaits it.
 */
function awaitOf(visit: Visit): Visit | undefined {
  let at: Visit | undefined = visit;
  while (at !== undefined && at.up?.node.type !== 'AwaitExpression') {
    at = chainedFrom(at);
  }
  return at?.up;
}

/** A use of the loader, of a module object's, or an `import()`, that `visit` is. */
function useAt(visit: Visit): Use | undefined {
  const { node } = visit;
  if (node.type === 'ImportExpression') {
    // Its failure is a rejection, which a `try` sees only where it is awaited in the block.
    const awaited = awaitOf(visit);
    return namesOneModule(node.source)
      ? undefined
      : { node, text: node, guarded: awaited !== undefined && inGuardedBlock(awaited) };
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
