import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterPackages, compareVersions, filterTokens, withStatus, withToken } from '../../src/webview/filter';
import type { PackageItem } from '../../src/apm/types';
const packages: PackageItem[] = [
  { id: 'b::sample', name: 'sample', marketplace: 'b', version: '1.9.0', installed: true, updateStatus: 'outdated', description: 'Code review' },
  { id: 'a::sample', name: 'sample', marketplace: 'a', version: '1.10.0', installed: false },
  { id: 'a::other', name: 'other', marketplace: 'a', version: 'Not specified', installed: true, updateStatus: 'unknown' }
];
const base = { text: '', marketplace: '', status: '', sort: 'name' as const };
test('shared filters match text, marketplace tokens and confirmed updates', () => {
  assert.equal(filterPackages(packages, { ...base, text: 'CODE @marketplace:b @updates' })[0].id, 'b::sample');
  assert.equal(filterPackages(packages, { ...base, text: '@installed' }).length, 2);
  assert.equal(filterPackages(packages, { ...base, text: '@updates' }).length, 1);
  assert.deepEqual(filterPackages(packages, { ...base, text: '@marketplace:a @sort:version-desc' }).map(p => p.id), ['a::sample', 'a::other']);
});
test('versions compare semantically, including prerelease precedence', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0);
  assert.ok(compareVersions('1.0.0-rc.10', '1.0.0-rc.2') > 0);
  assert.ok(compareVersions('1.0.0-1', '1.0.0-beta') < 0);
  assert.equal(compareVersions('v1.0.0+build', '1.0.0'), 0);
  assert.deepEqual(filterPackages(packages, base).filter(p => p.name === 'sample').map(p => p.id), ['a::sample', 'b::sample']);
});
test('filter token helpers back the native filter menu', () => {
  assert.deepEqual(filterTokens('kanban @marketplace:"my market" @updates @sort:version-desc'), { marketplace: 'my market', sort: 'version-desc', installed: false, updates: true });
  assert.equal(withToken('kanban @sort:version', '@sort:', 'name-desc'), 'kanban @sort:name-desc');
  assert.equal(withToken('kanban @marketplace:one', '@marketplace:', ''), 'kanban');
  assert.equal(withToken('', '@marketplace:', 'my market'), '@marketplace:"my market"');
  assert.equal(withStatus('kanban @installed', '@updates'), 'kanban @updates');
  assert.equal(withStatus('@updates kanban', ''), 'kanban');
});
