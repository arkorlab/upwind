import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { rolldown } from 'rolldown';
import { describe, expect, it } from 'vitest';

const ENTRY = '\0upwind-node-signal-control';
const TOKEN = 'synthetic-signal-control-token-with-32-bytes';
const CONFIGURATION = JSON.stringify({
  v: 1,
  deploymentId: 'synthetic-deployment',
  functionName: 'app',
  controlToken: TOKEN,
  capabilities: { services: {} },
});
const CONTROL_DEADLINE_MS = 5000;
type Scenario = 'success' | 'incomplete' | 'error' | 'watchdog' | 'library';
interface Witness {
  readonly kind: string;
  readonly snapshot?: { activeRequests: number; backgroundTasks: number; draining: boolean };
  readonly foreignHandle?: boolean;
  readonly code?: number;
}

/** Only this authored inert entry and runtime source are bundled; no Next application is built. */
async function source(scenario: Scenario): Promise<string> {
  const container = fileURLToPath(new URL('../src/node-container.ts', import.meta.url));
  const lifetime = fileURLToPath(new URL('../src/node-lifetime.ts', import.meta.url));
  const code = String.raw`
import {writeSync} from 'node:fs';
import {startNodeContainer} from ${JSON.stringify(container)};
import {NodeLifetime} from ${JSON.stringify(lifetime)};
const scenario=${JSON.stringify(scenario)};
const token=${JSON.stringify(TOKEN)};
const emit=value=>writeSync(1,JSON.stringify(value)+'\n');
const nativeTimer=globalThis.setTimeout;
if(scenario==='watchdog')globalThis.setTimeout=(callback,delay,...args)=>nativeTimer(callback,delay===30000?100:delay,...args);
if(scenario==='incomplete'){const drain=NodeLifetime.prototype.drain;NodeLifetime.prototype.drain=function(){return drain.call(this,0);};}
if(scenario==='error')NodeLifetime.prototype.drain=()=>Promise.reject(new Error('authored drain failure'));
if(scenario==='watchdog')NodeLifetime.prototype.drain=()=>new Promise(()=>{});
const body=Promise.withResolvers();const task=Promise.withResolvers();
const foreign=setInterval(()=>{},1000);
const server=await startNodeContainer({port:0,entry:{fetch(request,env,context){
 context.waitUntil(task.promise.then(()=>{emit({kind:'task-complete'});}));
 if(scenario!=='success')return Promise.resolve(new Response('complete'));
 return Promise.resolve(new Response(new ReadableStream({async start(controller){
  controller.enqueue(new TextEncoder().encode('first'));await body.promise;
  controller.enqueue(new TextEncoder().encode('last'));controller.close();emit({kind:'body-complete'});
 }})));
}}});
let signals=0;
const observed=()=>{signals+=1;emit({kind:signals===1?'signal':'signal-again',snapshot:server.snapshot()});};
process.on('SIGTERM',observed);process.on('SIGINT',observed);
process.on('exit',code=>{emit({kind:'exit',code,snapshot:server.snapshot(),foreignHandle:foreign.hasRef()});});
async function command(value){
 if(value==='body'){body.resolve();return;}
 if(value==='task'){task.resolve();return;}
 if(value==='close'){const drained=await server.close();emit({kind:'library-closed',code:drained?0:1});return;}
 if(value==='ping'){emit({kind:'alive',foreignHandle:foreign.hasRef()});return;}
 if(value!=='request')throw new Error('unknown authored command');
 const response=await fetch('http://127.0.0.1:'+server.port+'/',{headers:{'x-upwind-control-token':token,'x-upwind-request-url':'https://signal.example/'}});
 const reader=response.body.getReader();await reader.read();emit({kind:'response-started',snapshot:server.snapshot()});
 while(!(await reader.read()).done){}emit({kind:'response-complete'});
}
let pending='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{pending+=chunk;let index;
 while((index=pending.indexOf('\n'))!==-1){const value=pending.slice(0,index);pending=pending.slice(index+1);command(value).catch(()=>{emit({kind:'fixture-error'});process.exit(9);});}
});
emit({kind:'ready',foreignHandle:foreign.hasRef()});`;
  await using bundle = await rolldown({
    input: ENTRY,
    platform: 'node',
    plugins: [
      {
        name: 'authored-node-signal-control',
        resolveId: (id) => (id === ENTRY ? id : undefined),
        load: (id) => (id === ENTRY ? code : undefined),
      },
    ],
  });
  const output = await bundle.generate({ format: 'esm' });
  const chunk = output.output.find((part) => part.type === 'chunk');
  if (chunk?.type !== 'chunk') throw new Error('The authored signal control has no source chunk');
  return chunk.code;
}

async function fixture(scenario: Scenario) {
  const code = await source(scenario);
  // Run the current absolute Node executable, with only the inert bootstrap; never a PATH command.
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
    env: { NODE_ENV: 'production', ARKOR_NODE_RUNTIME: CONFIGURATION },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events: Witness[] = [];
  let changed = Promise.withResolvers<undefined>();
  let stopped = false;
  const completed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  const lines = createInterface({ input: child.stdout });
  function notify(): void {
    const previous = changed;
    changed = Promise.withResolvers<undefined>();
    previous.resolve(undefined);
  }
  lines.on('line', (line) => {
    // This pipe carries only the authored finite witness protocol above.
    events.push(JSON.parse(line) as Witness);
    notify();
  });
  child.stderr.resume();
  child.once('error', () => {
    stopped = true;
    completed.resolve({ code: -1, signal: null });
    notify();
  });
  child.once('close', (exitCode, signal) => {
    stopped = true;
    completed.resolve({ code: exitCode, signal });
    notify();
  });
  const deadline = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => {
    deadline.resolve(undefined);
  }, CONTROL_DEADLINE_MS);
  let expired = false;
  // This observation settles normally, and cleanup below clears its timer on every outcome.
  async function observeDeadline(): Promise<void> {
    await deadline.promise;
    expired = true;
  }
  const deadlineObserved = observeDeadline();
  async function waitFor(kind: string): Promise<Witness> {
    for (;;) {
      const found = events.find((event) => event.kind === kind);
      if (found !== undefined) return found;
      if (stopped || expired) throw new Error(`Authored signal control missed ${kind}`);
      await Promise.race([changed.promise, deadlineObserved]);
    }
  }
  return {
    child,
    events,
    waitFor,
    command(value: string) {
      child.stdin.write(`${value}\n`);
    },
    async exit() {
      await Promise.race([completed.promise, deadlineObserved]);
      if (expired && !stopped) throw new Error('Authored signal control did not exit');
      return await completed.promise;
    },
    async stop() {
      clearTimeout(timer);
      if (!stopped) child.kill('SIGKILL');
      await completed.promise;
      lines.close();
    },
  };
}

describe('node signal-owned process shutdown', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'drains active HTTP and waitUntil once before explicit %s exit despite a foreign interval',
    async (signal) => {
      const own = await fixture('success');
      try {
        await own.waitFor('ready');
        own.command('request');
        await own.waitFor('response-started');
        own.child.kill(signal);
        const first = await own.waitFor('signal');
        own.child.kill(signal);
        await own.waitFor('signal-again');
        own.command('body');
        await own.waitFor('response-complete');
        own.command('task');
        const ended = await own.exit();
        const exit = own.events.find((event) => event.kind === 'exit');

        expect(first.snapshot).toStrictEqual({
          activeRequests: 1,
          backgroundTasks: 1,
          draining: true,
        });
        expect(ended).toStrictEqual({ code: 0, signal: null });
        expect(own.events.map(({ kind }) => kind)).toContain('task-complete');
        expect(exit).toMatchObject({
          code: 0,
          foreignHandle: true,
          snapshot: { activeRequests: 0, backgroundTasks: 0, draining: true },
        });
      } finally {
        await own.stop();
      }
    },
  );

  it.each(['incomplete', 'error', 'watchdog'] as const)(
    'exits nonzero after a controlled %s drain instead of hanging on foreign handles',
    async (scenario) => {
      const own = await fixture(scenario);
      try {
        await own.waitFor('ready');
        own.command('request');
        await own.waitFor('response-complete');
        own.child.kill('SIGTERM');
        const ended = await own.exit();

        expect(ended).toStrictEqual({ code: 1, signal: null });
        expect(own.events.find((event) => event.kind === 'exit')).toMatchObject({
          code: 1,
          foreignHandle: true,
        });
      } finally {
        await own.stop();
      }
    },
  );

  it('keeps ordinary library close non-exiting with an unrelated live interval', async () => {
    const own = await fixture('library');
    try {
      await own.waitFor('ready');
      own.command('close');
      const closed = await own.waitFor('library-closed');
      own.command('ping');
      const alive = await own.waitFor('alive');

      expect(closed.code).toBe(0);
      expect(alive.foreignHandle).toBe(true);
      expect(own.child.exitCode).toBeNull();
    } finally {
      await own.stop();
    }
  });
});
