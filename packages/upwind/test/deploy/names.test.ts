import { createId } from '@stayingupwind/core/util';
import { describe, expect, it } from 'vitest';

import {
  appRuntimeOf,
  deploymentLabel,
  deploymentOfLabel,
  deploymentOfScript,
  functionScriptName,
  functionScripts,
  projectNameFromPackage,
  projectNames,
} from '../../src/deploy/names.ts';

const FUNCTION = {
  mainModule: 'index.mjs',
  modules: [],
  compatibilityDate: '2026-09-15',
  compatibilityFlags: [],
};

describe("a project's name", () => {
  it('is made from its package name', () => {
    expect(projectNameFromPackage('my-app')).toBe('my-app');
    expect(projectNameFromPackage('@acme/Shop_Front')).toBe('shop-front');
    expect(projectNameFromPackage('2024-site')).toBe('site');
    expect(projectNameFromPackage('a-very-long-package-name-that-goes-on')).toBe(
      'a-very-long-package-name',
    );
  });

  it('is nothing where the package name cannot be made into one', () => {
    expect(projectNameFromPackage(undefined)).toBeUndefined();
    expect(projectNameFromPackage('@acme/9')).toBeUndefined();
    expect(projectNameFromPackage('x')).toBeUndefined();
  });

  it('names everything the project keeps', () => {
    expect(projectNames('shop')).toStrictEqual({
      project: 'shop',
      edge: 'shop-edge',
      cache: 'shop-cache',
      cacheRead: 'shop-cache-read',
      prefetch: 'shop-prefetch',
      agent: 'shop-agent',
      edgeStateTitle: 'upwind:shop:edge-state',
      cacheStateTitle: 'upwind:shop:cache-state',
      artifactsBucket: 'shop-artifacts',
    });
    expect(() => projectNames('Shop')).toThrow(/not a project name/u);
  });
});

describe("a deployment's Workers", () => {
  const deploymentId = createId('dpl');

  it('are named by a label that turns back into the deployment', () => {
    const label = deploymentLabel(deploymentId);

    expect(label).toMatch(/^[a-z2-7]{25}$/u);
    expect(deploymentOfLabel(label)).toBe(deploymentId);
    expect(() => deploymentLabel('run_abc')).toThrow(/not a deployment id/u);
  });

  it('fit in a DNS label for the most Functions a build has', () => {
    const name = functionScriptName('a'.repeat(24), deploymentId, 'app-32');

    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('are known for their deployment by name alone', () => {
    const scriptName = functionScriptName('shop', deploymentId, 'app-2');

    expect(deploymentOfScript('shop', scriptName)).toBe(deploymentId);
    expect(deploymentOfScript('shop', 'shop-edge')).toBeUndefined();
    expect(deploymentOfScript('other', scriptName)).toBeUndefined();
  });

  it('are every Function of the build, the first first and the middleware last', () => {
    const bundle = {
      deploymentId,
      functions: {
        app: FUNCTION,
        split: { 'app-10': FUNCTION, 'app-2': FUNCTION },
        middleware: FUNCTION,
      },
    };
    const label = deploymentLabel(deploymentId);

    expect(functionScripts('shop', bundle)).toStrictEqual([
      { name: 'app', scriptName: `shop-${label}-app` },
      { name: 'app-2', scriptName: `shop-${label}-app-2` },
      { name: 'app-10', scriptName: `shop-${label}-app-10` },
      { name: 'middleware', scriptName: `shop-${label}-mw` },
    ]);
    expect(appRuntimeOf('shop', bundle)).toStrictEqual({
      deploymentId,
      scriptName: `shop-${label}-app`,
      middlewareScriptName: `shop-${label}-mw`,
      functions: { 'app-2': `shop-${label}-app-2`, 'app-10': `shop-${label}-app-10` },
    });
  });

  it('are one app Function where the build did not split', () => {
    expect(appRuntimeOf('shop', { deploymentId, functions: { app: FUNCTION } })).toStrictEqual({
      deploymentId,
      scriptName: `shop-${deploymentLabel(deploymentId)}-app`,
    });
  });
});
