import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { caseFailure } from './check-adapter-config.mjs';

test('retains separate bounded stdout, stderr and reasons for child failures', () => {
  const errors = [];
  for (const name of ['first', 'later']) {
    try {
      execFileSync(
        process.execPath,
        [
          '-e',
          `process.stdout.write('${name} output\\n' + 'x'.repeat(5000));
           process.stderr.write('${name} reason /control/adapter.mjs\\u0000');
           process.exit(7);`,
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      assert.fail('child should fail');
    } catch (error) {
      errors.push(caseFailure(error, '', '/control'));
    }
  }
  for (const [index, name] of ['first', 'later'].entries()) {
    const error = errors[index];
    assert.match(error.message, /Command failed/u);
    assert.ok(error.stdout.startsWith(`${name} output\n`));
    assert.equal(error.stderr, `${name} reason [adapter-control]/adapter.mjs`);
    assert.equal(error.stdout.length, 4096);
    assert.ok(error.message.length <= 2048);
    assert.ok(!JSON.stringify(error).includes('/control'));
    assert.ok(Object.values(error).every((value) => !value.includes('\u0000')));
  }
});

test('keeps child output when successful execution produces invalid JSON', () => {
  const stdout = 'not a JSON result\n';
  assert.throws(
    () => JSON.parse(stdout),
    (error) => {
      const detail = caseFailure(error, stdout);
      assert.match(detail.message, /JSON/u);
      assert.equal(detail.stdout, stdout);
      assert.equal(detail.stderr, '');
      return true;
    },
  );
});
