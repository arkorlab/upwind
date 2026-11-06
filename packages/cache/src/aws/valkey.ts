import { createCluster } from 'redis';

import { type AuthorityStore, type Stored, stored, type StorePage } from './types.ts';

// Constant parameterized script. Every comparison happens before the first mutation.
const CHANGE = `
local expected = cjson.decode(ARGV[1])
local writes = cjson.decode(ARGV[2])
local expires = cjson.decode(ARGV[4])
local deadline = tonumber(ARGV[3])
if deadline > 0 then
  local now = redis.call('TIME')
  if tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000) >= deadline then return 0 end
end
for i=3,#KEYS do
  local wanted = expected[i-2]
  if wanted ~= false then
    local current = redis.call('GET',KEYS[i])
    if wanted == cjson.null then
      if current then return 0 end
    elseif current ~= wanted then return 0 end
  end
end
for i=3,#KEYS do
  local value = writes[i-2]
  if value ~= false then
    if value == cjson.null then
      redis.call('DEL',KEYS[i])
      redis.call('ZREM',KEYS[1],KEYS[i])
      redis.call('ZREM',KEYS[2],KEYS[i])
    else
      redis.call('SET',KEYS[i],value)
      redis.call('ZADD',KEYS[1],0,KEYS[i])
      local expiry = expires[i-2]
      if expiry ~= false then
        redis.call('PEXPIREAT',KEYS[i],expiry)
        redis.call('ZADD',KEYS[2],expiry,KEYS[i])
      else redis.call('ZREM',KEYS[2],KEYS[i]) end
    end
  end
end
return 1`;

const SWEEP = `
local t=redis.call('TIME')
local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local expired=redis.call('ZRANGEBYSCORE',KEYS[2],0,now,'LIMIT',0,256)
for _,key in ipairs(expired) do
  if redis.call('EXISTS',key)==0 then redis.call('ZREM',KEYS[1],key) end
  redis.call('ZREM',KEYS[2],key)
end
return #expired`;

function newValkeyClient(url: string, username?: string, password?: string) {
  return createCluster({
    rootNodes: [{ url }],
    commandOptions: { timeout: 1000 },
    defaults: {
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1024,
      commandOptions: { timeout: 1000 },
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
      socket: {
        ...(new URL(url).protocol === 'rediss:' ? { tls: true as const } : { tls: false as const }),
        connectTimeout: 5000,
        reconnectStrategy: (attempt: number) =>
          attempt >= 8
            ? new Error('AWS Valkey connection retry budget exhausted')
            : Math.min(1000, 50 * 2 ** Math.min(attempt, 5)),
      },
    },
    useReplicas: false,
  });
}

export class ValkeyAuthorityStore implements AuthorityStore {
  readonly kind = 'valkey';
  readonly #client: ReturnType<typeof newValkeyClient>;
  readonly #prefix: string;
  readonly #index: string;
  readonly #expiryIndex: string;

  constructor(
    url: string,
    scope: string,
    username?: string,
    password?: string,
    allowLocalTest = false,
  ) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'rediss:' &&
      !(
        allowLocalTest &&
        parsed.protocol === 'redis:' &&
        (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
      )
    )
      throw new Error('AWS Valkey requires a rediss:// TLS URL');
    this.#prefix = `upwind:{${scope}}:`;
    this.#index = `${this.#prefix}keys`;
    this.#expiryIndex = `${this.#prefix}expires`;
    this.#client = newValkeyClient(url, username, password);
    this.#client.on('error', (error: unknown) => {
      // eslint-disable-next-line no-console -- Connection errors belong to the native server's operator.
      console.error(
        'upwind: AWS cache connection failed',
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  async connect(): Promise<void> {
    await this.#client.connect();
  }

  async now(): Promise<number> {
    const answer = await this.#client.eval(
      "local t=redis.call('TIME');return tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)",
      {
        keys: [this.#index],
        arguments: [],
      },
    );
    if (typeof answer !== 'number') throw new Error('Valkey returned an invalid authority clock');
    return answer;
  }

  async read<T>(key: string, signal?: AbortSignal): Promise<Stored<T> | undefined> {
    signal?.throwIfAborted();
    const raw = await this.#client
      .withCommandOptions({
        timeout: 1000,
        ...(signal === undefined ? {} : { abortSignal: signal }),
      })
      .get(`${this.#prefix}${key}`);
    signal?.throwIfAborted();
    return raw === null ? undefined : stored<T>(raw);
  }

  async readMany(
    keys: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, Stored>> {
    signal?.throwIfAborted();
    const unique = [...new Set(keys)];
    if (unique.length === 0) return new Map();
    const values = await this.#client
      .withCommandOptions({
        timeout: 1000,
        ...(signal === undefined ? {} : { abortSignal: signal }),
      })
      .mGet(unique.map((key) => `${this.#prefix}${key}`));
    signal?.throwIfAborted();
    const result = new Map<string, Stored>();
    unique.forEach((key, index) => {
      const raw = values[index];
      if (typeof raw === 'string') result.set(key, stored(raw));
    });
    return result;
  }

  async list(prefix: string, after?: string, limit = 100): Promise<StorePage> {
    const first = after === undefined ? `[${this.#prefix}${prefix}` : `(${this.#prefix}${after}`;
    const keys = await this.#client.zRangeByLex(
      this.#index,
      first,
      `[${this.#prefix}${prefix}\uffff`,
      {
        LIMIT: { offset: 0, count: limit + 1 },
      },
    );
    const selected = keys.slice(0, limit).map((key) => key.slice(this.#prefix.length));
    const values = await this.readMany(selected);
    const items = selected.flatMap((key) => {
      const value = values.get(key);
      return value === undefined ? [] : [{ key, stored: value }];
    });
    return { items, ...(keys.length > limit ? { cursor: selected.at(-1) } : {}) };
  }

  async change(
    expected: ReadonlyMap<string, string | null>,
    writes: ReadonlyMap<string, unknown | null>,
    notAfter?: number,
    expires: ReadonlyMap<string, number> = new Map(),
  ): Promise<boolean> {
    const keys = [...new Set([...expected.keys(), ...writes.keys()])];
    const answer = await this.#client.eval(CHANGE, {
      keys: [this.#index, this.#expiryIndex, ...keys.map((key) => `${this.#prefix}${key}`)],
      arguments: [
        JSON.stringify(keys.map((key) => (expected.has(key) ? expected.get(key) : false))),
        JSON.stringify(
          keys.map((key) =>
            writes.has(key)
              ? writes.get(key) === null
                ? null
                : JSON.stringify(writes.get(key))
              : false,
          ),
        ),
        String(notAfter ?? 0),
        JSON.stringify(keys.map((key) => expires.get(key) ?? false)),
      ],
    });
    return answer === 1;
  }

  close(): Promise<void> {
    if (this.#client.isOpen) this.#client.destroy();
    return Promise.resolve();
  }

  async sweepExpired(): Promise<void> {
    await this.#client.eval(SWEEP, { keys: [this.#index, this.#expiryIndex], arguments: [] });
  }
}
