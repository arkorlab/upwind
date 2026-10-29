import { Module } from 'node:module';

import type { NodeJwtBuiltinBasis } from './node-jwt-realm.ts';
import { initializeNodeSlowBuffer } from './node-slow-buffer.ts';

export interface NodeInitializationBuiltins {
  readonly basis: NodeJwtBuiltinBasis;
  readonly values: readonly (readonly [string, unknown])[];
}

/** Native builtins only, captured before installing any dependency-owned loader hook. */
export function nodeInitializationBuiltins(require: NodeJS.Require): NodeInitializationBuiltins {
  const buffer = require('node:buffer') as Record<string, unknown>;
  initializeNodeSlowBuffer(buffer);
  const crypto: unknown = require('node:crypto');
  const stream: unknown = require('node:stream');
  const util: unknown = require('node:util');
  const websocket = {
    crypto,
    stream,
    events: require('node:events') as unknown,
    fs: require('node:fs') as unknown,
    http: require('node:http') as unknown,
    https: require('node:https') as unknown,
    net: require('node:net') as unknown,
    path: require('node:path') as unknown,
    tls: require('node:tls') as unknown,
    url: require('node:url') as unknown,
    zlib: require('node:zlib') as unknown,
  };
  return {
    basis: { buffer, crypto, stream, util, loader: Module, websocket },
    values: [
      ['buffer', buffer],
      ['crypto', crypto],
      ['stream', stream],
      ['util', util],
      ['events', websocket.events],
      ['http', websocket.http],
      ['https', websocket.https],
      ['net', websocket.net],
      ['tls', websocket.tls],
      ['url', websocket.url],
      ['zlib', websocket.zlib],
    ],
  };
}
