import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { messageHeaders, messageRequest } from '../src/node-http.ts';

describe('node connection-specific headers', () => {
  it('joins repeated Cookie fields with semicolons while preserving other list headers', () => {
    const socket = new Socket();
    try {
      const message = new IncomingMessage(socket);
      message.rawHeaders = [
        'Cookie',
        'first=1',
        'cookie',
        'second=2',
        'COOKIE',
        'third=3',
        'X-List',
        'one',
        'X-List',
        'two',
      ];

      expect([...messageHeaders(message)]).toStrictEqual([
        ['cookie', 'first=1; second=2; third=3'],
        ['x-list', 'one, two'],
      ]);
    } finally {
      socket.destroy();
    }
  });

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

describe('node request body framing', () => {
  it.each([
    ['DELETE', undefined],
    ['OPTIONS', undefined],
    ['POST', undefined],
    ['DELETE', '0'],
    ['OPTIONS', '0'],
    ['POST', '0'],
  ])('keeps a bodyless %s with Content-Length %s bodyless', (method, length) => {
    const socket = new Socket();
    try {
      const message = new IncomingMessage(socket);
      message.method = method;
      if (length !== undefined) {
        message.headers['content-length'] = length;
        message.rawHeaders = ['Content-Length', length];
      }
      const request = messageRequest(
        message,
        'https://request.test/',
        messageHeaders(message),
        new AbortController().signal,
      );

      expect(request.body).toBeNull();
    } finally {
      socket.destroy();
    }
  });

  it.each(['content-length', 'transfer-encoding'])(
    'keeps the streamed payload declared by %s',
    async (framing) => {
      const socket = new Socket();
      try {
        const message = new IncomingMessage(socket);
        message.method = 'DELETE';
        const value = framing === 'content-length' ? '3' : 'chunked';
        message.headers[framing] = value;
        message.rawHeaders = [framing, value];
        message.push(Buffer.from('abc'));
        message.push(null);
        const request = messageRequest(
          message,
          'https://request.test/',
          messageHeaders(message),
          new AbortController().signal,
        );

        await expect(request.text()).resolves.toBe('abc');
        expect(request.headers.has('transfer-encoding')).toBe(false);
      } finally {
        socket.destroy();
      }
    },
  );
});
