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

export type Ordering = 'name' | 'name-desc' | 'marketplace';
export interface Filters { text: string; marketplace: string; status: string; sort: Ordering }

export function filterPackages(items: PackageItem[], filters: Filters): PackageItem[] {
  let marketplace = filters.marketplace, status = filters.status, sort = filters.sort;
  let scope = '';
  const terms: string[] = [];
  for (const token of filters.text.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    if (token.startsWith('@marketplace:')) marketplace = token.slice(13).replaceAll('"', '');
    else if (token === '@installed') status = 'installed';
    else if (token === '@updates') status = 'updates';
    else if (token === '@dependencies') status = 'dependencies';
    else if (/^@scope:(workspace|global)$/.test(token)) scope = token.slice(7);
    else if (token.startsWith('@sort:')) {
      const requested = token.slice(6);
      if (['name', 'name-desc', 'marketplace'].includes(requested)) sort = requested as Ordering;
    }
    else terms.push(token.replaceAll('"', '').toLowerCase());
  }
  return items.filter(item => (!marketplace || item.marketplace === marketplace) &&
    (!scope || item.scope?.kind === scope || item.installations?.some(installation => installation.scope?.kind === scope)) &&
    (!['installed', 'dependencies'].includes(status) || item.installed) &&
    (status !== 'updates' || (scope && item.installations
      ? item.installations.some(installation => installation.scope?.kind === scope && installation.updateStatus === 'outdated')
      : item.updateStatus === 'outdated')) &&
    terms.every(term => `${item.name} ${item.description ?? ''} ${item.marketplace}`.toLowerCase().includes(term)))
    .sort((a, b) => {
      let order = 0;
      if (sort === 'marketplace') order = a.marketplace.localeCompare(b.marketplace);
      else order = a.name.localeCompare(b.name) * (sort === 'name-desc' ? -1 : 1);
      return order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
}

const tokenPattern = /(?:[^\s"]+|"[^"]*")+/g;
export interface FilterTokens { marketplace: string; scope: string; sort: Ordering; installed: boolean; updates: boolean; dependencies: boolean }
export function filterTokens(search: string): FilterTokens {
  const sort = search.match(/@sort:(\S+)/)?.[1] ?? 'name';
  return {
    marketplace: search.match(/@marketplace:("[^"]*"|\S+)/)?.[1]?.replaceAll('"', '') ?? '',
    scope: search.match(/(?:^|\s)@scope:(workspace|global)(?=\s|$)/)?.[1] ?? '',
    sort: (['name', 'name-desc', 'marketplace'].includes(sort) ? sort : 'name') as Ordering,
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
