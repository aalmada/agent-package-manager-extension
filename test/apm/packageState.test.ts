import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUpdateRows, findInstalledPackage, reconcileDetailContexts, retainUpdateResults } from '../../src/apm/packageState';
import type { PackageItem, Scope, UpdateRow } from '../../src/apm/types';

const workspace: Scope = { kind: 'workspace', path: '/project', label: 'project' };
const global: Scope = { kind: 'global', path: '/home/.apm', label: 'global' };
const catalog: PackageItem = { id: 'market::sample', name: 'sample', marketplace: 'market', version: '2.0', installed: false };
const installed: PackageItem = {
  ...catalog, version: '1.0', installed: true, updateStatus: 'outdated', latestVersion: '2.0',
  metadata: { cliIdentity: 'org/sample', lockIdentity: 'org/sample' }
};

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
