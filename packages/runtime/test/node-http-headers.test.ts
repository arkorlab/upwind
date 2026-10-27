import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { messageHeaders } from '../src/node-http.ts';

describe('node connection-specific headers', () => {
  it('ignores malformed Connection tokens while stripping every valid nominated header', () => {
    const socket = new Socket();

    try {
      const message = new IncomingMessage(socket);
      message.rawHeaders = ['X-Hop', 'private', 'X-Stay', 'public', 'X-Other-Hop', 'private'];
      message.headers.connection = 'keep-alive, bad name, X-Hop, , X-Other-Hop';
      const headers = messageHeaders(message);

      expect([...headers]).toStrictEqual([['x-stay', 'public']]);
    } finally {
      socket.destroy();
    }
  });
});
