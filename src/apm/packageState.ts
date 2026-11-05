import { record } from './adapters';
import type { PackageItem, Scope, UpdateRow } from './types';

function samePackage(a: PackageItem, b: PackageItem): boolean {
  return a.id === b.id || (!!a.marketplace && a.marketplace === b.marketplace && a.name === b.name);
}

function revision(item: PackageItem): string {
  const lock = record(item.metadata?.lock) ? item.metadata.lock : undefined;
  return JSON.stringify([lock?.resolved_commit, lock?.resolved_ref]);
}

export function findInstalledPackage(item: PackageItem, installed: readonly PackageItem[]): PackageItem | undefined {
  return installed.find(candidate => candidate.id === item.id) ?? installed.find(candidate => samePackage(item, candidate));
}

export function applyUpdateRows(installed: readonly PackageItem[], updates: readonly UpdateRow[]): PackageItem[] {
  return installed.map(item => {
    const identity = item.metadata?.cliIdentity ?? item.name;
    const row = updates.find(update => update.package === identity || update.package === item.metadata?.lockIdentity);
    return {
      ...item, updateStatus: row?.status ?? 'unknown', latestVersion: row?.latest, updateStale: undefined,
      metadata: { ...item.metadata, ...(row ? { update: row } : {}) }
    };
  });
}

export function retainUpdateResults(installed: readonly PackageItem[], previous: readonly PackageItem[]): PackageItem[] {
  return installed.map(item => {
    const prior = previous.find(candidate => samePackage(item, candidate) && candidate.version === item.version && revision(candidate) === revision(item));
    const hasResult = prior?.updateStatus !== undefined && ['current', 'outdated', 'unknown', 'not-comparable'].includes(prior.updateStatus);
    return {
      ...item, updateStatus: hasResult ? prior.updateStatus : 'failed',
      latestVersion: hasResult ? prior.latestVersion : undefined, updateStale: hasResult
    };
  });
}

interface DetailContext {
  scope?: Scope;
  item?: PackageItem;
}

export function reconcileDetailContexts<T extends DetailContext>(
  contexts: Iterable<T>, scope: Scope, catalog: readonly PackageItem[], installed: readonly PackageItem[],
  reload: (context: T) => void
): void {
  for (const context of contexts) {
    const current = context.item;
    if (!current || !context.scope || context.scope.kind !== scope.kind || context.scope.path !== scope.path) continue;
    const installedItem = findInstalledPackage(current, installed);
    const available = catalog.find(item => samePackage(current, item));
    const item = installedItem ?? {
      ...(available ?? current), installed: false, updateStatus: undefined, latestVersion: undefined, updateStale: undefined
    };
    context.item = item;
    if (item.id !== current.id || item.installed !== current.installed || item.version !== current.version ||
      item.source !== current.source || revision(item) !== revision(current)) reload(context);
  }
}
