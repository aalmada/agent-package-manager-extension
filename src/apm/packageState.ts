import { record } from './adapters';
import { isSameScope } from '../protocol';
import type { PackageItem, Scope, UpdateRow } from './types';

export function getUpdateBadge(state: { trusted: boolean; version?: string; warning?: string; installed: readonly PackageItem[] }): { value: number; tooltip: string } | undefined {
  if (!state.trusted || !state.version) return undefined;
  const packages = state.installed.filter(item => item.updateStatus === 'outdated');
  const cliUpdate = !!state.warning;
  const value = packages.length + Number(cliUpdate);
  if (!value) return undefined;
  const parts: string[] = [];
  if (packages.length) parts.push(`${packages.length} package update${packages.length === 1 ? '' : 's'}`);
  if (cliUpdate) parts.push('1 APM CLI update');
  const cached = packages.some(item => item.updateStale) ? ' (includes saved package update results)' : '';
  return { value, tooltip: `${parts.join(' and ')} available${cached}` };
}

function samePackage(a: PackageItem, b: PackageItem): boolean {
  return a.id === b.id || (!!a.marketplace && a.marketplace === b.marketplace && a.name === b.name);
}

function sameScope(a: Scope | undefined, b: Scope | undefined): boolean {
  return !a || !b || isSameScope(a, b);
}

export function withInstallations(catalog: readonly PackageItem[], installed: readonly PackageItem[]): PackageItem[] {
  return catalog.map(item => {
    const installations = installed.filter(candidate => samePackage(item, candidate));
    const update = installations.find(candidate => candidate.updateStatus === 'outdated')
      ?? installations.find(candidate => candidate.updateStatus === 'failed' || candidate.updateStatus === 'unknown')
      ?? installations.find(candidate => candidate.updateStatus === 'not-comparable')
      ?? installations.find(candidate => candidate.updateStatus === 'unchecked')
      ?? installations[0];
    return { ...item, installations, installed: installations.length > 0, updateStatus: update?.updateStatus,
      latestVersion: update?.latestVersion, updateStale: update?.updateStale };
  });
}

function revision(item: PackageItem): string {
  const lock = record(item.metadata?.lock) ? item.metadata.lock : undefined;
  return JSON.stringify([lock?.resolved_commit, lock?.resolved_ref]);
}

export function findInstalledPackage(item: PackageItem, installed: readonly PackageItem[]): PackageItem | undefined {
  const candidates = installed.filter(candidate => sameScope(item.scope, candidate.scope));
  return candidates.find(candidate => candidate.id === item.id) ?? candidates.find(candidate => samePackage(item, candidate));
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

export function retainUpdateResults(installed: readonly PackageItem[], previous: readonly PackageItem[], stale = true): PackageItem[] {
  return installed.map(item => {
    const prior = previous.find(candidate => sameScope(item.scope, candidate.scope) && samePackage(item, candidate) && candidate.version === item.version && revision(candidate) === revision(item));
    const hasResult = prior?.updateStatus !== undefined && ['current', 'outdated', 'unknown', 'not-comparable'].includes(prior.updateStatus);
    return {
      ...item, updateStatus: hasResult ? prior.updateStatus : stale ? 'failed' : item.updateStatus ?? 'unchecked',
      latestVersion: hasResult ? prior.latestVersion : undefined, updateStale: hasResult ? stale || prior.updateStale : stale ? false : undefined
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
    if (!current || !context.scope || !isSameScope(context.scope, scope)) continue;
    const installedItem = findInstalledPackage({ ...current, scope }, installed);
    const available = catalog.find(item => samePackage(current, item));
    const item = installedItem ?? {
      ...(available ?? current), scope, installed: false, updateStatus: undefined, latestVersion: undefined, updateStale: undefined
    };
    context.item = item;
    if (item.id !== current.id || item.installed !== current.installed || item.version !== current.version ||
      item.source !== current.source || revision(item) !== revision(current)) reload(context);
  }
}
