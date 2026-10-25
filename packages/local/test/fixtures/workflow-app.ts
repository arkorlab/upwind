import { resourcesOf, RESOURCES_SYMBOL_KEY } from '@stayingupwind/core/paas';
import { workflow } from '../../../sdk/src/named.ts';

/** A built application exercises the public SDK through the private preview bridge. */
async function handle(request: Request, env: Record<string, unknown>): Promise<Response> {
    Object.defineProperty(globalThis, Symbol.for(RESOURCES_SYMBOL_KEY), {
      value: resourcesOf(env),
      configurable: true,
    });
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response('preview ready');
    if (url.pathname === '/resources') {
      return Response.json({
        names: Object.keys(resourcesOf(env).resources).toSorted((one, other) => one.localeCompare(other)),
        unknown: workflow('UNREGISTERED') === undefined,
      });
    }
    const jobs = workflow(url.searchParams.get('binding') ?? 'JOBS');
    if (jobs === undefined) return new Response('no such Workflow binding', { status: 404 });
    const id = url.searchParams.get('id') ?? 'test';
    if (url.pathname === '/create') {
      return Response.json(await jobs.create({ id, params: { value: id, nested: url.searchParams.get('binding') === 'JOBS' } }));
    }
    if (url.pathname === '/batch') {
      const instances = await jobs.createBatch([{ id: 'legacy-batch', params: { value: 'batch' } }]);
      return Response.json(instances.map(({ id: instanceId }) => ({ id: instanceId })));
    }
    if (url.pathname === '/batchObject') {
      const result = await jobs.createBatch({ instances: [{ id: 'object-batch', params: { value: 'batch' } }] });
      return Response.json({ ...result, created: result.created.map(({ id: instanceId }) => ({ id: instanceId })) });
    }
    const instance = await jobs.get(id);
    switch (url.pathname) {
      case '/status': { return Response.json(await instance.status());
      }
      case '/pause': { await instance.pause(); break;
      }
      case '/resume': { await instance.resume(); break;
      }
      case '/restart': { await instance.restart(); break;
      }
      case '/terminate': { await instance.terminate(); break;
      }
      case '/delete': { await instance.delete(); break;
      }
      case '/sendEvent': { await instance.sendEvent({ type: 'approved', payload: true }); break;
      }
      default: { return new Response('unknown operation', { status: 404 });
      }
    }
    return Response.json({ id: instance.id });
}

const app = {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      return Response.json({ message: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  },
};

// eslint-disable-next-line import-x/no-default-export -- A built Worker exposes its fetch handler.
export default app;
