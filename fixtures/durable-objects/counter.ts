import { DurableObject } from 'cloudflare:workers';

/** Native SQLite and RPC, with construction visible to the focused check. */
export class Counter extends DurableObject {
  constructor(state: DurableObjectState, env: { UPWIND_KV: KVNamespace }) {
    super(state, env);
    state.blockConcurrencyWhile(async () => { await env.UPWIND_KV.put("constructed", "yes"); });
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS counter (value INTEGER NOT NULL)');
    if (state.storage.sql.exec('SELECT value FROM counter').toArray().length === 0) {
      state.storage.sql.exec('INSERT INTO counter (value) VALUES (0)');
    }
  }

  increment(): number {
    this.ctx.storage.sql.exec('UPDATE counter SET value = value + 1');
    return this.ctx.storage.sql.exec<{ value: number }>('SELECT value FROM counter').one().value;
  }

  fetch(): Response {
    return Response.json({ value: this.increment() });
  }
}
