import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionUpdateKind } from '../../src/apm/versions';

test('classifies stable SemVer bumps and leaves ambiguous versions generic', () => {
  assert.equal(versionUpdateKind('1.2.3', '1.2.4'), 'patch');
  assert.equal(versionUpdateKind('1.2.3', '1.3.0'), 'minor');
  assert.equal(versionUpdateKind('1.2.3', '2.0.0'), 'major');
  assert.equal(versionUpdateKind('0.2.3', '0.3.0'), 'available');
  assert.equal(versionUpdateKind('1.2.3-beta.1', '1.2.3'), 'available');
  assert.equal(versionUpdateKind('Not specified', '2.0.0'), 'available');
  assert.equal(versionUpdateKind('1.2.3', undefined), 'available');
});
