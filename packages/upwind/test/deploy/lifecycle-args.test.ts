import path from 'node:path';

import { createId } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

import { parseDeploymentsRequest, parseRollbackRequest } from '../../src/deploy/args.ts';

describe('what `upwind deployments` and `upwind rollback` understand', () => {
  it('takes a directory, the current one by default', () => {
    expect(parseDeploymentsRequest(['site'])).toStrictEqual({
      answer: undefined,
      options: { projectDir: path.resolve('site') },
    });
    expect(parseDeploymentsRequest(['--help'])).toStrictEqual({ answer: 'help' });
    expect(() => parseDeploymentsRequest(['a', 'b'])).toThrow(/at most one directory/u);
  });

  it('takes the deployment to go back to by its id, and nothing else for one', () => {
    const deploymentId = createId('dpl');

    expect(parseRollbackRequest(['--to', deploymentId])).toStrictEqual({
      answer: undefined,
      options: { projectDir: path.resolve('.'), to: deploymentId },
    });
    expect(parseRollbackRequest([])).toStrictEqual({
      answer: undefined,
      options: { projectDir: path.resolve('.'), to: undefined },
    });
    expect(() => parseRollbackRequest(['--to', 'yesterday'])).toThrow(/a deployment's id/u);
    expect(() => parseRollbackRequest(['--yes'])).toThrow(/Unknown option '--yes'/u);
  });
});
