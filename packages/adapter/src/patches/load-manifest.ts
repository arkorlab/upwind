import { type Patch, Rewrite } from './types.ts';

/**
 * `load-manifest.external.js` evaluates a client reference manifest — a script — with `node:vm`,
 * in a context holding `process.env.NEXT_DEPLOYMENT_ID`. workerd has no `vm`. The adapter runs
 * that same evaluation at build time and ships the resulting context as JSON next to the script's
 * name (see `manifests.ts`); the loader reads the JSON and assigns it into its context object
 * instead. A manifest the build did not ship still fails the read, which the `handleMissing`
 * branch turns into `{}` as before.
 */

const NAME = 'load-manifest';
const TARGET = /load-manifest\.external\.js$/u;
const EVAL_READ = "content = (0, _fs.readFileSync)(/* turbopackIgnore: true */ path, 'utf8');";
const EVAL_READ_SITES = 2;
const EVAL_RUN = '(0, _vm.runInNewContext)(content, contextObject);';
const VM_REQUIRE = 'const _vm = require("vm");';
const LEFTOVERS = ['runInNewContext', 'require("vm")', "require('vm')", 'node:vm'];

export const loadManifestPatch: Patch = {
  name: NAME,
  target: TARGET,
  nextVersions: ['16.3.5', '16.3.6'],
  apply(source, file) {
    const result = new Rewrite(NAME, file, source)
      .replace(
        EVAL_READ,
        String.raw`content = (0, _fs.readFileSync)(path.replace(/\.js$/, '.json'), 'utf8');`,
        EVAL_READ_SITES,
        'the manifest read',
      )
      .replace(
        EVAL_RUN,
        'Object.assign(contextObject, JSON.parse(content));',
        1,
        'the manifest evaluation',
      )
      .replace(VM_REQUIRE, '', 1, 'the vm import')
      .forbid(LEFTOVERS, 'a use of node:vm');
    return { contents: result.contents, edits: result.edits, notes: [] };
  },
};
