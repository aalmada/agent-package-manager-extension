import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, versionUpdateKind } from '../../src/apm/versions';

test('classifies stable SemVer bumps and leaves ambiguous versions generic', () => {
  assert.equal(versionUpdateKind('1.2.3', '1.2.4'), 'patch');
  assert.equal(versionUpdateKind('1.2.3', '1.3.0'), 'minor');
  assert.equal(versionUpdateKind('1.2.3', '2.0.0'), 'major');
  assert.equal(versionUpdateKind('0.2.3', '0.3.0'), 'available');
  assert.equal(versionUpdateKind('1.2.3-beta.1', '1.2.3'), 'available');
  assert.equal(versionUpdateKind('Not specified', '2.0.0'), 'available');
  assert.equal(versionUpdateKind('1.2.3', undefined), 'available');
});

test('compares versions by numeric parts and SemVer prerelease precedence', () => {
  assert.equal(compareVersions('1.2.10', '1.2.9') > 0, true);
  assert.equal(compareVersions('1.2.3', '1.2.3-beta'), 1);
  assert.equal(compareVersions('1.2.3-alpha.2', '1.2.3-alpha.10') < 0, true);
  assert.equal(compareVersions('1.2.3-alpha', '1.2.3-alpha.1') < 0, true);
});

test('orders valid versions before invalid versions and sorts invalid versions lexically', () => {
  assert.equal(compareVersions('1.2.3', 'Not specified'), -1);
  assert.equal(compareVersions('Not specified', '1.2.3'), 1);
  assert.equal(compareVersions('invalid-a', 'invalid-b') < 0, true);
});
