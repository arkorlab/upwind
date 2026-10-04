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
 * method of it that loads, in the block of a `try` whose `catch` and `finally` are plain code — no
 * `throw`, `await`, `yield` or `try` of their own, no pattern taking the error apart, nothing made
 * and run where it stands, no `Promise.reject(…)` or `eval`, and calls only of what they name — and
 * an `import()` too, where it, or a promise chained from it, is awaited there, or where a `catch` of
 * its own chain hands its rejection to a function made there whose body is plain, and so is each one
 * the chain runs past it. Such a load fails in the Function as it fails under
 * Node.js when the module is not installed, into the code's own `catch`:
 * `@protobufjs/inquire`, which every `protobufjs` loads its optional modules through, and
 * TypeScript's `sys.require`, which loads a compiler plugin, are written that way. Plain, because
 * whether a `catch` lets a failure out cannot be told of code in general: what is not plain is not
 * trusted, and what a `catch` or a `finally` calls by name is taken not to throw, nor to answer
 * with a rejection — it is not followed. Not across code that runs later — a function's body,
 * unless the function is neither `async` nor a generator and is called or constructed where it is
 * made, and an instance field's initializer or a constructor, unless the class is constructed
 * where it is made: a `try` around their definition catches nothing they throw when they run —
 * and never `require.bind`, which makes a loader rather than loading.
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

/** A function's body runs when the function is called: later, unless it is called at once. */
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

/**
 * What `node` constructs where it is made — a class, `new (class { … })()`, or a function,
 * `new (function () { … })()` — or `undefined`.
 */
function constructedAtOnce(node: Node): Node | undefined {
  if (node.type !== 'NewExpression') {
    return undefined;
  }
  const callee = unwrapped(node.callee);
  if (callee.type === 'ClassExpression') {
    return callee;
  }
  return callee.type === 'FunctionExpression' && !callee.async && !callee.generator
    ? callee
    : undefined;
}

/** Whether `member`, a member of a class, is one of a class constructed where it is made. */
function ofClassConstructedAtOnce(member: Visit): boolean {
  const made = member.up?.up;
  if (made === undefined) {
    return false;
  }
  let at: Visit | undefined = made.up;
  while (at?.node.type === 'ParenthesizedExpression' || at?.node.type === 'SequenceExpression') {
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
      (call !== undefined && (calledAtOnce(call) === node || constructedAtOnce(call) === node)) ||
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

/**
 * What a `catch` or a `finally` may be made of and be trusted to keep a failure in: statements that
 * only go on or return, and expressions that only compute — a function among them as a value, its
 * body run later if at all. A `switch` goes on: it picks its case by `===`, which cannot throw.
 * Everything else — `throw`, `await`, `yield`, a `try` of its own, a class, a pattern to take the
 * error apart with — is not plain, and the `try` guards nothing.
 */
const PLAIN_TYPES: ReadonlySet<string> = new Set([
  'ArrayExpression',
  'ArrowFunctionExpression',
  'AssignmentExpression',
  'BinaryExpression',
  'BlockStatement',
  'BreakStatement',
  'CatchClause',
  'ChainExpression',
  'ConditionalExpression',
  'ContinueStatement',
  'DebuggerStatement',
  'EmptyStatement',
  'ExpressionStatement',
  'FunctionDeclaration',
  'FunctionExpression',
  'Identifier',
  'IfStatement',
  'Literal',
  'LogicalExpression',
  'MemberExpression',
  'ObjectExpression',
  'ParenthesizedExpression',
  'Property',
  'ReturnStatement',
  'SequenceExpression',
  'SwitchCase',
  'SwitchStatement',
  'TemplateElement',
  'TemplateLiteral',
  'ThisExpression',
  'UnaryExpression',
  'UpdateExpression',
  'VariableDeclaration',
  'VariableDeclarator',
]);

/** The globals that run code they are handed as text, which may throw anything: not trusted. */
const CODE_RUNNERS: ReadonlySet<string> = new Set(['eval', 'Function']);

/** What a name a function is called by starts from: a binding, or the object a method runs on. */
const NAMED_BASES: ReadonlySet<string> = new Set(['Identifier', 'Super', 'ThisExpression']);

/**
 * Whether `call` — a call or a `new` — calls a function by its name (`log(error)`,
 * `this.logger.warn(error)`, `new Error(message)`), rather than one made where it stands, which
 * would run there; and not `Promise.reject`, which is how a function that answers with a promise
 * throws, nor `eval` or `Function` — by their names or as a property (`globalThis.eval`) — which
 * run code they are handed as text, nor `new Promise(…)`, which runs its executor there.
 */
function callsByName(call: Node): boolean {
  if (call.type !== 'CallExpression' && call.type !== 'NewExpression') {
    return false;
  }
  const callee = unwrapped(call.callee);
  const rejects =
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Promise' &&
    propertyName(callee) === 'reject';
  // `new Promise(executor)` runs the executor where it stands, and it may reject.
  if (call.type === 'NewExpression' && callee.type === 'Identifier' && callee.name === 'Promise') {
    return false;
  }
  let base: Node = call.callee;
  let runsCode = false;
  for (let next = towardTheName(base); next !== undefined; next = towardTheName(base)) {
    const name = propertyName(base);
    runsCode ||= name !== undefined && CODE_RUNNERS.has(name);
    base = next;
  }
  runsCode ||= base.type === 'Identifier' && CODE_RUNNERS.has(base.name);
  return !rejects && !runsCode && NAMED_BASES.has(base.type);
}
/**
 * One step down a callee toward the name it is called by: out of parentheses, to the last of a
 * sequence, a member's object, a call's callee. `undefined` where there is no step left.
 */
function towardTheName(node: Node): Node | undefined {
  if (node.type === 'MemberExpression') {
    return node.object;
  }
  return node.type === 'CallExpression' ? node.callee : innerOf(node);
}

/** Whether `node` reads a property off `null` or `undefined` as written, which always throws. */
function readsOffNothing(node: Node): boolean {
  if (node.type !== 'MemberExpression' || node.optional) {
    return false;
  }
  const base = unwrapped(node.object);
  if (base.type === 'Literal') {
    return base.value === null;
  }
  if (base.type === 'UnaryExpression') {
    return base.operator === 'void';
  }
  return base.type === 'Identifier' && base.name === 'undefined';
}

/**
 * Whether running `node` keeps a failure in: it is plain code (`PLAIN_TYPES`), and what it calls it
 * calls by name (`callsByName`) — which is taken not to throw, nor to answer with a rejection. A
 * function among it is a value; its body runs later, if at all, and is not read. Plain code is
 * taken not to throw of itself: beyond a read off `null` or `undefined`, an expression written to
 * throw on its own is no way to handle a failure, and is not looked for.
 */
function keepsIn(node: Node | null): boolean {
  const pending: Node[] = node === null ? [] : [node];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const call = at.type === 'CallExpression' || at.type === 'NewExpression';
    if (call ? !callsByName(at) : !PLAIN_TYPES.has(at.type) || readsOffNothing(at)) {
      return false;
    }
    if (!FUNCTION_TYPES.has(at.type)) {
      pending.push(...childrenOf(at));
    }
  }
  return true;
}

/**
 * Whether a `try` keeps in the failure of what its block runs: it has a `catch`, and that and its
 * `finally` are plain code (`keepsIn`). One that throws — the same error, another made of it, or
 * what the `catch` put aside, thrown again by the `finally` — lets the load's failure out as surely
 * as no `catch` at all, and so may anything that is not plain.
 */
function keepsFailureIn(statement: Node): boolean {
  return (
    statement.type === 'TryStatement' &&
    statement.handler !== null &&
    keepsIn(statement.handler) &&
    keepsIn(statement.finalizer)
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

/**
 * What carries on the promise `at` makes: the parentheses around it, the optional chain it ends
 * (`import(name)?.then(use)`, which a promise never cuts short), or a call of its method.
 */
function chainedFrom(at: Visit): Visit | undefined {
  const { up } = at;
  if (up === undefined) {
    return undefined;
  }
  if (up.node.type === 'ParenthesizedExpression' || up.node.type === 'ChainExpression') {
    return up;
  }
  // `(0, import(name))` is the promise, as the last of a sequence.
  if (up.node.type === 'SequenceExpression') {
    return Object.is(up.node.expressions.at(-1), at.node) ? up : undefined;
  }
  const name = propertyName(up.node);
  const method = at.key === 'object' && name !== undefined && PROMISE_METHODS.has(name);
  return method && up.key === 'callee' && up.up?.node.type === 'CallExpression' ? up.up : undefined;
}

/**
 * Whether `handler`, handed a rejection, keeps it in: a function made there, whose parameters are
 * plain names and whose body is plain code. A handler passed by name is not read, and so not
 * trusted: what the name holds may be no function at all, and the rejection then goes on.
 */
function handlesPlainly(handler: Node | undefined): boolean {
  const fn = handler === undefined ? undefined : unwrapped(handler);
  if (fn?.type !== 'ArrowFunctionExpression' && fn?.type !== 'FunctionExpression') {
    return false;
  }
  return fn.params.every((param) => param.type === 'Identifier') && keepsIn(fn.body);
}

/** The handler `call` — a promise's `catch`, or its `then` with two — gives a rejection, if any. */
function rejectionHandlerOf(call: Node): Node | undefined {
  if (call.type !== 'CallExpression') {
    return undefined;
  }
  const name = propertyName(unwrapped(call.callee));
  if (name === 'catch') {
    return call.arguments[0];
  }
  return name === 'then' ? call.arguments[1] : undefined;
}

/**
 * Whether what `argument` hands a promise runs plainly when the promise calls it: each function
 * made in it is read as a handler is (`handlesPlainly`), and what it names is taken not to throw,
 * as what a `catch` calls by name is.
 */
function callsBackPlainly(argument: Node): boolean {
  const pending: Node[] = [argument];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const made = FUNCTION_TYPES.has(at.type);
    if (made && !handlesPlainly(at)) {
      return false;
    }
    if (!made) {
      pending.push(...childrenOf(at));
    }
  }
  return true;
}

/**
 * Whether the promise the chain from `visit` ends in — calls of the promise's own methods —
 * fulfils when the load fails. The rejection passes every callback by until a handler has it, and a
 * `catch`, or a `then` with a second handler, that handles it plainly (`handlesPlainly`) keeps it
 * in. Once any handler has had it — a handler by name, or one not plain, may answer too — the chain
 * goes on with the answer, and every callback it is handed from then on has to run plainly
 * (`callsBackPlainly`): one that throws — a `finally` that does, a `then` that throws the error the
 * handler answered with — rejects the promise the chain ends in, unless a handler past it takes
 * that plainly in turn. Only the chain as written is read: a promise kept, and chained on where the
 * record cannot see, is not followed, as the code after a `try` is not.
 */
function handledInChain(visit: Visit): boolean {
  // Along the load's failure: whether the promise made so far fulfils, and whether it may — which
  // it may once any handler has had the rejection.
  let fulfils = false;
  let mayFulfil = false;
  for (let at = chainedFrom(visit); at !== undefined; at = chainedFrom(at)) {
    if (at.node.type !== 'CallExpression') {
      continue;
    }
    const call = at.node;
    // An argument that throws as it is evaluated stops the call before its handler is attached.
    if (call.arguments.some((argument) => !keepsIn(argument))) {
      return false;
    }
    const handler = rejectionHandlerOf(call);
    const handles = handlesPlainly(handler);
    if (mayFulfil) {
      fulfils =
        (fulfils || handles) && call.arguments.every((argument) => callsBackPlainly(argument));
    } else {
      fulfils = handles;
      mayFulfil = handler !== undefined;
    }
  }
  return fulfils;
}

/**
 * The `await` of the promise `visit` makes, or of one chained from it — `import(name).then(use)` —
 * or `undefined` where nothing awaits it. Not through what the promise is handed to or put in, though
 * that may await it: `Promise.all([…])` is the global's only where no scope binds `Promise` otherwise,
 * which cannot be told without resolving scopes, and `for await` over a list awaits each promise
 * only when it reaches it — one past a `break`, or past an earlier one's rejection, rejects with
 * nothing to see it.
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
    // Its failure is a rejection, which a `try` sees only where it is awaited in the block, and a
    // handler of its own sees wherever it is.
    const awaited = awaitOf(visit);
    const guarded = (awaited !== undefined && inGuardedBlock(awaited)) || handledInChain(visit);
    return namesOneModule(node.source) ? undefined : { node, text: node, guarded };
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
