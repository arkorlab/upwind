/* eslint-disable unicorn/no-keyword-prefix -- Native registration metadata uses className. */
import { describe, expect, it } from 'vitest';

import { runtimeOptions } from '../src/resources/local-runtime-options.ts';

describe('combined local native class capabilities', () => {
  it('keeps Workflow and Container workers on the same project bindings', () => {
    const options = runtimeOptions('/project', {
      entries: [
        { name: 'DATA', type: 'kv_namespace' },
        { name: 'OBJECT', type: 'durable_object_namespace' },
        { name: 'JOBS', type: 'workflow' },
      ],
      objects: [
        {
          declaration: {
            name: 'OBJECT',
            module: 'object.ts',
            className: 'Object',
            container: {
              image: { reference: 'alpine:3.22' },
              instanceType: 'lite',
              maxInstances: 1,
            },
          },
          source: 'export class UpwindDurableObject {}',
          inputs: [],
          containerImageName: 'local-image:latest',
        },
      ],
      workflows: [
        {
          declaration: { name: 'JOBS', module: 'jobs.ts', className: 'Jobs' },
          source: 'export class UpwindCloudflareWorkflow {}',
          inputs: [],
        },
      ],
      ai: {
        entries: [],
        dispose: async () => {
          /* No remote session is allocated. */
        },
      },
    });
    const workers = options.workers;
    const expectedSocketPath: unknown = expect.any(String);

    expect(options).toMatchObject({
      containerEngine: { localDocker: { socketPath: expectedSocketPath } },
    });
    expect(workers).toHaveLength(3);

    for (const worker of workers) {
      expect(worker).toMatchObject({
        config: {
          env: {
            DATA: { type: 'kv', id: 'DATA-upwind-local' },
            OBJECT: { type: 'durable-object', worker: 'upwind-object-OBJECT' },
            JOBS: { type: 'workflow', worker: 'upwind-workflow-JOBS' },
          },
        },
      });
    }

    const expectedObjectConfig: unknown = expect.objectContaining({
      name: 'upwind-object-OBJECT',
      exports: {
        UpwindDurableObject: {
          type: 'durable-object',
          storage: 'sqlite',
          container: { imageName: 'local-image:latest' },
        },
      },
    });

    expect(workers).toContainEqual(expect.objectContaining({ config: expectedObjectConfig }));
  });
});
