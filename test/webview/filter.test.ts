import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterPackages, filterTokens, withStatus, withToken } from '../../src/webview/filter';
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
  assert.equal(filterPackages(packages, { ...base, text: '@dependencies' }).length, 2);
  assert.deepEqual(filterPackages(packages, { ...base, text: 'review @dependencies @marketplace:b' }).map(p => p.id), ['b::sample']);
  assert.deepEqual(filterPackages(packages, { ...base, text: '@marketplace:a @sort:version-desc' }).map(p => p.id), ['a::other', 'a::sample']);
});
test('direct installations filter, search and sort by their catalog marketplace', () => {
  const direct: PackageItem = { id: 'installed::org/plugins/direct', name: 'direct', marketplace: '', catalogMarketplace: 'team-market',
    source: 'org/plugins', version: '1.0.0', installed: true };
  const items = [...packages, direct];
  assert.deepEqual(filterPackages(items, { ...base, text: '@marketplace:team-market' }).map(p => p.id), [direct.id]);
  assert.deepEqual(filterPackages(items, { ...base, text: 'team-market' }).map(p => p.id), [direct.id]);
  assert.deepEqual(filterPackages(items, { ...base, text: '@sort:marketplace' }).map(p => p.id), ['a::other', 'a::sample', 'b::sample', direct.id]);
});
test('unsupported sort tokens do not sort by version', () => {
  assert.equal(filterTokens('@sort:version-desc').sort, 'name');
  assert.deepEqual(filterPackages(packages, base).filter(p => p.name === 'sample').map(p => p.id), ['a::sample', 'b::sample']);
});
test('filter token helpers back the native filter menu', () => {
  assert.deepEqual(filterTokens('kanban @marketplace:"my market" @updates @sort:marketplace'), { marketplace: 'my market', scope: '', sort: 'marketplace', installed: false, updates: true, dependencies: false });
  assert.equal(filterTokens('@dependencies').dependencies, true);
  assert.equal(withToken('kanban @sort:version', '@sort:', 'name-desc'), 'kanban @sort:name-desc');
  assert.equal(withToken('kanban @marketplace:one', '@marketplace:', ''), 'kanban');
  assert.equal(withToken('', '@marketplace:', 'my market'), '@marketplace:"my market"');
  assert.equal(withStatus('kanban @installed', '@updates'), 'kanban @updates');
  assert.equal(withStatus('@updates kanban', ''), 'kanban');
  assert.equal(withStatus('kanban @updates', '@dependencies'), 'kanban @dependencies');
  assert.equal(withStatus('kanban @dependencies', '@installed'), 'kanban @installed');
});

test('scope filters match installations without borrowing update status from the other scope', () => {
  const workspace: PackageItem = { ...packages[0], scope: { kind: 'workspace', label: 'project', path: '/project' } };
  const global: PackageItem = { ...packages[0], updateStatus: 'current', scope: { kind: 'global', label: 'Global', path: '/user/.apm' } };
  const catalog: PackageItem = { ...packages[0], installations: [global, workspace] };
  assert.deepEqual(filterPackages([global, workspace], { ...base, text: '@scope:workspace' }), [workspace]);
  assert.deepEqual(filterPackages([global, workspace], { ...base, text: '@scope:global' }), [global]);
  assert.equal(filterPackages([catalog], { ...base, text: '@updates @scope:global' }).length, 0);
  assert.equal(filterPackages([catalog], { ...base, text: '@updates @scope:workspace' }).length, 1);
  assert.equal(filterTokens('@scope:global').scope, 'global');
  assert.equal(withToken('@scope:global @updates', '@scope:', ''), '@updates');
  assert.equal(filterTokens(withToken('@scope:global @updates', '@scope:', '')).scope, '');
});
