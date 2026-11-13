import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCatalogVersions, applyUpdateRows, findInstalledPackage, getUpdateBadge, marketplaceLabel, reconcileDetailContexts, retainUpdateResults, withCatalogInfo, withInstallations } from '../../src/apm/packageState';
import type { PackageItem, Scope, UpdateRow } from '../../src/apm/types';

const workspace: Scope = { kind: 'workspace', path: '/project', label: 'project' };
const global: Scope = { kind: 'global', path: '/home/.apm', label: 'global' };
const catalog: PackageItem = { id: 'market::sample', name: 'sample', marketplace: 'market', version: '2.0', installed: false };
const installed: PackageItem = {
  ...catalog, version: '1.0', installed: true, updateStatus: 'outdated', latestVersion: '2.0',
  metadata: { cliIdentity: 'org/sample', lockIdentity: 'org/sample' }
};

test('one catalog package retains both independent installations and update states', () => {
  const project = { ...installed, scope: workspace };
  const user = { ...installed, scope: global, version: '2.0', updateStatus: 'current' as const };
  const [item] = withInstallations([catalog], [user, project]);
  assert.equal(item.installed, true);
  assert.equal(item.installations?.length, 2);
  assert.equal(item.updateStatus, 'outdated');
  assert.equal(findInstalledPackage({ ...catalog, scope: workspace }, [user, project]), project);
  assert.equal(findInstalledPackage({ ...catalog, scope: global }, [project]), undefined);
  assert.equal(retainUpdateResults([{ ...project, updateStatus: 'unchecked' }], [user])[0].updateStatus, 'failed');
  assert.equal(withInstallations([catalog], [user])[0].updateStatus, 'current');
  assert.equal(withInstallations([catalog], [{ ...user, updateStatus: 'failed' }])[0].updateStatus, 'failed');
  assert.equal(withInstallations([catalog], [])[0].installed, false);
  assert.equal(getUpdateBadge({ trusted: true, version: '0.35.0', installed: [project, { ...project, scope: global }] })?.value, 2);
});

test('direct installations show the marketplace of a unique catalog source without changing their identity', () => {
  const entry: PackageItem = { ...catalog, sourceIdentity: 'sample-source', description: 'Sample skills' };
  const metadata = { cliIdentity: 'org/plugins/sample', installExpression: 'org/plugins/sample' };
  const direct: PackageItem = { id: 'installed::org/plugins/sample', name: 'sample', marketplace: '', version: '1.0', installed: true,
    source: 'org/plugins', sourceIdentity: entry.sourceIdentity, metadata };
  const [labelled] = withCatalogInfo([direct], [entry]);
  assert.equal(marketplaceLabel(labelled), 'market');
  assert.equal(labelled.description, 'Sample skills');
  assert.equal(labelled.marketplace, '');
  assert.equal(labelled.id, direct.id);
  assert.equal(labelled.metadata, metadata);
  assert.equal(applyCatalogVersions([labelled], [{ ...entry, version: '9.0' }])[0].updateStatus, undefined,
    'A display label does not turn a direct installation into a marketplace comparison');
  assert.equal(marketplaceLabel(withCatalogInfo([direct], [entry, { ...entry, id: 'other::sample', marketplace: 'other' }])[0]), '',
    'An ambiguous source keeps its repository label');
  assert.equal(marketplaceLabel(withCatalogInfo([{ ...labelled }], [])[0]), '', 'A label is dropped when the catalog no longer lists the source');
  assert.equal(marketplaceLabel(withCatalogInfo([{ ...direct, sourceIdentity: 'other-source' }], [entry])[0]), '');
  assert.equal(withCatalogInfo([installed], [entry])[0].catalogMarketplace, undefined);
  assert.equal(marketplaceLabel(installed), 'market');
});

test('activity badge counts package updates plus one CLI upgrade and clears at zero', () => {
  const state = { trusted: true, version: '0.35.0', installed: [installed] };
  assert.deepEqual(getUpdateBadge(state), { value: 1, tooltip: '1 package update available' });
  const packages = [
    installed, { ...installed, id: 'market::second' },
    ...(['current', 'unchecked', 'unknown', 'failed', 'not-comparable'] as const).map(updateStatus => ({ ...installed, updateStatus }))
  ];
  assert.deepEqual(getUpdateBadge({ ...state, installed: packages }), { value: 2, tooltip: '2 package updates available' });
  assert.deepEqual(getUpdateBadge({ ...state, installed: packages, warning: 'Update APM.' }), {
    value: 3, tooltip: '2 package updates and 1 APM CLI update available'
  });
  assert.deepEqual(getUpdateBadge({ ...state, installed: [], warning: 'Update APM.' }), { value: 1, tooltip: '1 APM CLI update available' });
  assert.equal(getUpdateBadge({ ...state, installed: [] }), undefined);
  assert.equal(getUpdateBadge({ ...state, installed: [{ ...installed, updateStatus: 'current' }] }), undefined);
  assert.equal(getUpdateBadge({ ...state, version: undefined, warning: 'Update APM.' }), undefined);
  assert.equal(getUpdateBadge({ ...state, trusted: false, warning: 'Update APM.' }), undefined);
});

test('activity badge preserves saved update counts and identifies them in the tooltip', () => {
  assert.deepEqual(getUpdateBadge({ trusted: true, version: '0.35.0', installed: [{ ...installed, updateStale: true }], warning: 'Update APM.' }), {
    value: 2, tooltip: '1 package update and 1 APM CLI update available (includes saved package update results)'
  });
});

test('refresh reconciles open tabs only for their own scope and reloads changed package metadata', () => {
  const projectTab = { scope: workspace, item: installed };
  const globalTab = { scope: global, item: { ...installed, version: '0.5' } };
  const loaded: string[] = [];
  const fresh = { ...installed, updateStatus: 'current' as const, latestVersion: '1.0' };
  reconcileDetailContexts([projectTab, globalTab], workspace, [catalog], [fresh], entry => loaded.push(entry.scope.path));
  assert.equal(projectTab.item.updateStatus, 'current');
  assert.equal(globalTab.item.version, '0.5');
  assert.equal(loaded.length, 0);

  reconcileDetailContexts([projectTab, globalTab], workspace, [catalog], [], entry => loaded.push(entry.scope.path));
  assert.equal(projectTab.item.installed, false);
  assert.equal(projectTab.item.version, '2.0');
  assert.equal(projectTab.item.updateStatus, undefined);
  assert.equal(globalTab.item.installed, true);
  assert.deepEqual(loaded, ['/project']);

  reconcileDetailContexts([projectTab, globalTab], global, [{ ...catalog, installed: true, updateStatus: 'outdated' }], [], entry => loaded.push(entry.scope.path));
  assert.equal(globalTab.item.installed, false);
  assert.equal(globalTab.item.updateStatus, undefined);
  assert.deepEqual(loaded, ['/project', '/home/.apm']);
});

test('direct packages absent from the catalog become uninstalled without losing their source', () => {
  const direct: PackageItem = { id: 'installed::org/skill', name: 'org/skill', marketplace: '', version: '1', installed: true, source: 'org/skill', updateStatus: 'outdated' };
  const entry = { scope: workspace, item: direct };
  reconcileDetailContexts([entry], workspace, [], [], () => undefined);
  assert.equal(entry.item.installed, false);
  assert.equal(entry.item.source, 'org/skill');
  assert.equal(entry.item.updateStatus, undefined);
  assert.equal(findInstalledPackage(direct, [{ ...direct, id: 'installed::other', name: direct.name }]), undefined);
});

test('update results distinguish fresh, saved and failed checks', () => {
  const row: UpdateRow = { package: 'org/sample', current: '1.0', latest: '2.0', status: 'outdated', source: 'git' };
  const fresh = applyUpdateRows([{ ...installed, updateStale: true }], [row])[0];
  assert.equal(fresh.updateStatus, 'outdated');
  assert.equal(fresh.updateStale, undefined);
  assert.equal(retainUpdateResults([installed], [fresh])[0].updateStale, true);
  const failed = retainUpdateResults([installed], [{ ...installed, updateStatus: 'unchecked' }])[0];
  assert.equal(failed.updateStatus, 'failed');
  assert.equal(failed.updateStale, false);
  assert.equal(failed.latestVersion, undefined);
});

test('a changed lock revision reloads metadata and does not reuse an old update result', () => {
  const old = { ...installed, metadata: { ...installed.metadata, lock: { resolved_commit: 'old', resolved_ref: 'main' } } };
  const updated = { ...installed, metadata: { ...installed.metadata, lock: { resolved_commit: 'new', resolved_ref: 'main' } } };
  const entry = { scope: workspace, item: old };
  let reloads = 0;
  reconcileDetailContexts([entry], workspace, [catalog], [updated], () => { reloads++; });
  assert.equal(reloads, 1);
  assert.equal(retainUpdateResults([updated], [old])[0].updateStatus, 'failed');
});

test('catalog versions give immediate update results that APM refines only with definitive rows', () => {
  const lockIdentity = 'NTT-ORG/plugins/plugins/meta';
  const item = (version: string): PackageItem => ({ id: 'market::meta', name: 'meta', marketplace: 'market', version, installed: true,
    updateStatus: 'unchecked', metadata: { cliIdentity: 'meta', lockIdentity } });
  const entry = (version: string, stale = false): PackageItem => ({ id: 'market::meta', name: 'meta', marketplace: 'market', version, installed: false,
    ...(stale ? { metadata: { stale } } : {}) });
  const [outdated] = applyCatalogVersions([item('6.0.6')], [entry('6.0.7')]);
  assert.equal(outdated.updateStatus, 'outdated');
  assert.equal(outdated.latestVersion, '6.0.7');
  assert.equal(applyCatalogVersions([item('6.0.7')], [entry('6.0.7')])[0].updateStatus, 'current');
  assert.equal(applyCatalogVersions([item('6.0.6')], [entry('6.0.7', true)])[0].updateStatus, 'unchecked');
  assert.equal(applyCatalogVersions([item('Not specified')], [entry('6.0.7')])[0].updateStatus, 'unchecked');
  const row = (status: UpdateRow['status']): UpdateRow => ({ package: lockIdentity.toLowerCase(), current: '(none)', latest: '-', status, source: 'apm outdated' });
  assert.equal(applyUpdateRows([outdated], [row('unknown')])[0].updateStatus, 'outdated');
  assert.equal(applyUpdateRows([outdated], [])[0].updateStatus, 'outdated');
  assert.equal(applyUpdateRows([outdated], [row('current')])[0].updateStatus, 'current');
  assert.equal(applyUpdateRows([item('6.0.6')], [row('outdated')])[0].updateStatus, 'outdated');
  assert.equal(retainUpdateResults([outdated], [])[0].updateStatus, 'outdated');
  assert.equal(retainUpdateResults([outdated], [{ ...outdated, updateStatus: 'current', metadata: {} }])[0].updateStatus, 'current');
});
