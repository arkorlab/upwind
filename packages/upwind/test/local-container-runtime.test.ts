import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

import { DURABLE_OBJECT_EXPORT } from '../../core/src/bundle/durable-objects.ts';
import { prepareLocalContainers } from '../src/resources/local-containers.ts';
import type { LocalDurableObject } from '../src/resources/local-objects.ts';
import { localRuntimeOptions } from '../src/resources/local.ts';

const TIMEOUT_MS = 120_000;
const SOURCE = `import {DurableObject} from 'cloudflare:workers';
export class ${DURABLE_OBJECT_EXPORT} extends DurableObject {
 async fetch(request) {
  const container=this.ctx.container;
  if(!container) throw new Error('Container binding missing');
  if(!container.running) container.start();
  const url=new URL(request.url);url.protocol='http:';url.host='container';
  const forwarded=new Request(url,request);forwarded.headers.delete('host');
  let lastError;
  for(let attempt=0;attempt<300;attempt++) {
   try { return await container.getTcpPort(8080).fetch(forwarded); }
   catch(error) { lastError=error; await new Promise(resolve=>setTimeout(resolve,100)); }
  }
  throw new Error('Container did not start: '+String(lastError));
 }
}`;

describe.skipIf(process.env['UPWIND_CONTAINER_INTEGRATION'] !== '1')(
  'native local Container runtime',
  () => {
    it(
      'builds an image and reaches its port through the configured native namespace',
      async () => {
        const project = await mkdtemp(path.join(tmpdir(), 'upwind-container-runtime-'));
        let runtime: Miniflare | undefined;
        try {
          await writeFile(
            path.join(project, 'Dockerfile'),
            [
              'FROM docker.io/library/node:24-alpine',
              'WORKDIR /app',
              'COPY server.cjs /app/server.cjs',
              'CMD ["node", "/app/server.cjs"]',
            ].join('\n'),
          );
          await writeFile(
            path.join(project, 'server.cjs'),
            "require('node:http').createServer((request,response)=>response.end('container-ready:'+request.url)).listen(8080,'0.0.0.0');",
          );
          const object: LocalDurableObject = {
            declaration: {
              name: 'COMPUTE',
              module: 'object.ts',
              // eslint-disable-next-line unicorn/no-keyword-prefix -- The native class registration field.
              className: 'Compute',
              container: {
                image: { dockerfile: 'Dockerfile', buildContext: '.' },
                instanceType: 'lite',
                maxInstances: 1,
              },
            },
            source: SOURCE,
            inputs: [],
          };
          const objects = await prepareLocalContainers(project, [object], {
            files: new Set(),
            versions: new Map(),
          });

          expect(objects).toHaveLength(1);

          runtime = new Miniflare(
            localRuntimeOptions(
              project,
              [{ name: 'COMPUTE', type: 'durable_object_namespace' }],
              objects,
              {
                entries: [],
                dispose: async () => {
                  /* The fixture allocates no remote AI session. */
                },
              },
            ),
          );
          const namespace = await runtime.getDurableObjectNamespace('COMPUTE', 'upwind-local');
          const stub = namespace.get(namespace.idFromName('startup'));
          const response = await stub.fetch('http://container.test/native-port');

          expect(response.status).toBe(200);
          await expect(response.text()).resolves.toBe('container-ready:/native-port');
        } finally {
          await runtime?.dispose();
          await rm(project, { recursive: true, force: true });
        }
      },
      TIMEOUT_MS,
    );
  },
);
