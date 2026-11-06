import type { PackageItem } from '../apm/types';
import type { BrowserSection, State } from '../protocol';

export function sectionPackages(section: BrowserSection, state: Pick<State, 'catalog' | 'installed'>): PackageItem[] {
  switch (section) {
    case 'catalog': return state.catalog;
    case 'installed': return state.installed;
    case 'updates': return state.installed.filter(item => item.updateStatus === 'outdated');
    case 'direct': return state.installed.filter(item => item.direct === true);
    case 'transitive': return state.installed.filter(item => item.direct === false);
    case 'unclassified': return state.installed.filter(item => item.direct === undefined);
  }
}

export type Ordering = 'name' | 'name-desc' | 'marketplace' | 'version' | 'version-desc';
export interface Filters { text: string; marketplace: string; status: string; sort: Ordering }

function versionParts(value: string): { numbers: number[]; pre: string[] } | undefined {
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  return match ? { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] } : undefined;
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) return left ? -1 : right ? 1 : a.localeCompare(b);
  for (let i = 0; i < 3; i++) if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] - right.numbers[i];
  if (!left.pre.length || !right.pre.length) return left.pre.length ? -1 : right.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    return xn && yn ? Number(x) - Number(y) : xn ? -1 : yn ? 1 : x.localeCompare(y);
  }
  return 0;
}

export function filterPackages(items: PackageItem[], filters: Filters): PackageItem[] {
  let marketplace = filters.marketplace, status = filters.status, sort = filters.sort;
  const terms: string[] = [];
  for (const token of filters.text.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    if (token.startsWith('@marketplace:')) marketplace = token.slice(13).replaceAll('"', '');
    else if (token === '@installed') status = 'installed';
    else if (token === '@updates') status = 'updates';
    else if (token === '@dependencies') status = 'dependencies';
    else if (token.startsWith('@sort:') && ['name', 'name-desc', 'marketplace', 'version', 'version-desc'].includes(token.slice(6))) sort = token.slice(6) as Ordering;
    else terms.push(token.replaceAll('"', '').toLowerCase());
  }
  return items.filter(item => (!marketplace || item.marketplace === marketplace) &&
    (!['installed', 'dependencies'].includes(status) || item.installed) && (status !== 'updates' || item.updateStatus === 'outdated') &&
    terms.every(term => `${item.name} ${item.description ?? ''} ${item.marketplace}`.toLowerCase().includes(term)))
    .sort((a, b) => {
      let order = 0;
      if (sort === 'marketplace') order = a.marketplace.localeCompare(b.marketplace);
      else if (sort.startsWith('version')) {
        const validA = !!versionParts(a.version), validB = !!versionParts(b.version);
        order = validA !== validB ? (validA ? -1 : 1) : compareVersions(a.version, b.version) * (sort === 'version-desc' ? -1 : 1);
      } else order = a.name.localeCompare(b.name) * (sort === 'name-desc' ? -1 : 1);
      return order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
}

const tokenPattern = /(?:[^\s"]+|"[^"]*")+/g;
export interface FilterTokens { marketplace: string; sort: Ordering; installed: boolean; updates: boolean; dependencies: boolean }
export function filterTokens(search: string): FilterTokens {
  const sort = search.match(/@sort:(\S+)/)?.[1] ?? 'name';
  return {
    marketplace: search.match(/@marketplace:("[^"]*"|\S+)/)?.[1]?.replaceAll('"', '') ?? '',
    sort: (['name', 'name-desc', 'marketplace', 'version', 'version-desc'].includes(sort) ? sort : 'name') as Ordering,
    installed: /(?:^|\s)@installed(?=\s|$)/.test(search),
    updates: /(?:^|\s)@updates(?=\s|$)/.test(search),
    dependencies: /(?:^|\s)@dependencies(?=\s|$)/.test(search)
  };
}
export function withToken(search: string, prefix: string, value: string): string {
  const kept = (search.match(tokenPattern) ?? []).filter(token => !token.startsWith(prefix)).join(' ');
  return value ? `${kept} ${prefix}${value.includes(' ') ? `"${value}"` : value}`.trim() : kept;
}
export function withStatus(search: string, value: '' | '@installed' | '@updates' | '@dependencies'): string {
  const kept = search.replace(/(?:^|\s)@(installed|updates|dependencies)(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  return value ? `${kept} ${value}`.trim() : kept;
}
