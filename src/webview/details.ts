import { record } from '../apm/adapters';
import { contentTypes, declaredContents, mergeContents, type ContentGroup, type ContentItem } from '../apm/contents';
import type { PackageItem } from '../apm/types';
import type { ActionResult } from '../apm/actions';
import { el } from './dom';

function label(key: string): string {
  const known: Record<string, string> = {
    mcpServers: 'MCP servers', lspServers: 'LSP servers', url: 'URL', sha: 'Commit',
    repo: 'Repository', ref: 'Ref', installExpression: 'Install expression', cliIdentity: 'CLI identity',
    lockIdentity: 'Lockfile identity'
  };
  if (known[key]) return known[key];
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' &&
    (!Array.isArray(value) || value.length > 0) && (!record(value) || Object.keys(value).length > 0);
}

function externalLink(text: string, value: string): HTMLAnchorElement | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password) return undefined;
    const link = el('a', '', text);
    link.href = url.href;
    return link;
  } catch {
    return undefined;
  }
}

function valueNode(value: unknown, depth = 0, parentKey = ''): HTMLElement {
  if (depth > 8) return el('span', 'muted', 'Additional nested information is not shown.');
  if (typeof value === 'string') return externalLink(value, value) ?? el('span', '', value);
  if (typeof value === 'number') return el('span', '', String(value));
  if (typeof value === 'boolean') return el('span', '', value ? 'Yes' : 'No');
  if (Array.isArray(value)) {
    const list = el('ul', 'detail-values');
    for (const entry of value) {
      if (!hasValue(entry)) continue;
      const item = el('li');
      item.append(valueNode(entry, depth + 1));
      list.append(item);
    }
    return list;
  }
  if (record(value)) {
    const wrapper = el('div', 'detail-object');
    const authorLink = typeof value.name === 'string' && typeof value.url === 'string' ? externalLink(value.name, value.url) : undefined;
    if (authorLink) wrapper.append(authorLink);
    const fields = Object.entries(value).filter(([key, entry]) =>
      hasValue(entry) && !(authorLink && (key === 'name' || key === 'url')) && key !== 'plugins'
    ).map(([key, entry]): [string, unknown] => [parentKey === 'source' && key === 'source' ? 'type' : key, entry]);
    if (fields.length) wrapper.append(fieldList(fields, depth + 1));
    return wrapper;
  }
  return el('span', 'muted', 'Not specified');
}

function fieldList(fields: [string, unknown][], depth = 0): HTMLDListElement {
  const list = el('dl', depth ? 'detail-fields detail-fields-nested' : 'detail-fields');
  for (const [key, value] of fields) {
    if (!hasValue(value)) continue;
    const description = el('dd');
    description.append(valueNode(value, depth, key));
    list.append(el('dt', '', label(key)), description);
  }
  return list;
}

function tags(...sources: unknown[]): string[] {
  const values: string[] = [];
  for (const source of sources) {
    if (!record(source)) continue;
    for (const key of ['keywords', 'tags', 'Tags']) {
      const value = source[key];
      const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
      for (const entry of entries) if (typeof entry === 'string' && entry.trim()) values.push(entry.trim());
    }
  }
  const seen = new Set<string>();
  return values.filter(value => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function contentGroups(value: unknown): ContentGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: ContentGroup[] = [];
  for (const group of value) {
    if (!record(group) || !Array.isArray(group.items)) continue;
    const kind = contentTypes.find(type => type.key === group.kind)?.key;
    if (!kind) continue;
    const items: ContentItem[] = [];
    for (const item of group.items) {
      if (!record(item) || typeof item.name !== 'string' || !item.name.trim()) continue;
      items.push({
        name: item.name,
        ...(typeof item.path === 'string' ? { path: item.path } : {}),
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        ...(typeof item.navigationId === 'string' ? { navigationId: item.navigationId } : {}),
        ...(item.locationKind === 'source' || item.locationKind === 'installed' || item.locationKind === 'deployed' ? { locationKind: item.locationKind } : {})
      });
    }
    if (items.length) groups.push({ kind, items });
  }
  return groups;
}

function contentSection(groups: ContentGroup[], loading: boolean, available: boolean, notes: string[] = [], navigate?: (id: string) => void): HTMLElement {
  const section = el('section', 'details-section');
  section.append(el('h2', '', 'Contents'));
  for (const note of notes) {
    const warning = el('p', 'notice warning content-note', note);
    warning.setAttribute('role', 'note');
    section.append(warning);
  }
  if (!groups.length) {
    section.append(el('p', 'muted', loading ? 'Loading package contents...' :
      available ? 'No listed skills, agents, or other supported contents were found.' : 'Package contents are not available from this source.'));
    return section;
  }
  for (const group of groups) {
    const definition = contentTypes.find(type => type.key === group.kind);
    if (!definition) continue;
    const groupNode = el('section', 'content-group');
    const heading = el('h3');
    heading.append(el('span', '', definition.label), el('span', 'content-count', String(group.items.length)));
    groupNode.append(heading);
    const list = el('ul', 'content-list');
    for (const item of group.items) {
      const row = el('li', 'content-item');
      const body = el('div', 'content-item-body');
      body.append(el('strong', '', item.name));
      if (item.navigationId && navigate) {
        const open = el('button', 'secondary', `Open ${item.locationKind === 'installed' ? 'installed package source' : item.locationKind === 'deployed' ? 'deployed content' : 'source'}`);
        open.id = `open-${item.navigationId}`;
        open.type = 'button'; open.addEventListener('click', () => navigate(item.navigationId!)); body.append(open);
      }
      body.append(el('p', item.description ? 'content-description' : 'content-description muted',
        item.description ?? 'Description not available.'));
      row.append(body);
      list.append(row);
    }
    groupNode.append(list);
    section.append(groupNode);
  }
  return section;
}

export function renderDetailSections(item: PackageItem, details: Record<string, unknown> | undefined, loading: boolean, navigate?: (id: string) => void): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const plugin = record(details?.plugin) ? details.plugin : record(item.metadata?.plugin) ? item.metadata.plugin : undefined;
  const pluginManifest = record(details?.packageManifest) ? details.packageManifest : undefined;
  const manifest = record(details?.manifest) ? details.manifest : undefined;
  const tagValues = tags(plugin, pluginManifest, manifest, details);
  if (tagValues.length) {
    const section = el('section', 'details-section');
    section.append(el('h2', '', 'Tags'));
    const list = el('ul', 'detail-tags');
    for (const tag of tagValues) {
      const element = el('li', 'detail-tag badge', tag);
      list.append(element);
    }
    section.append(list);
    fragment.append(section);
  }

  const contents = mergeContents(declaredContents(plugin, pluginManifest, manifest), contentGroups(details?.contents));
  const notes = (Array.isArray(details?.contentsNotes) ? details.contentsNotes : [])
    .filter((note): note is string => typeof note === 'string' && !!note);
  fragment.append(contentSection(contents, loading, !!details && !details.contentsNotice && !details.metadataError &&
    !(Array.isArray(details.contentsNotices) && details.contentsNotices.length), notes, navigate));
  for (const message of [details?.metadataNotice, details?.metadataError, details?.contentsNotice,
    ...(Array.isArray(details?.contentsNotices) ? details.contentsNotices : [])]) {
    if (typeof message === 'string' && message) fragment.append(el('p', 'notice', message));
  }

  const primary: Record<string, unknown> = { ...manifest, ...pluginManifest, ...plugin };
  const ignored = new Set(['name', 'version', 'description', 'keywords', 'tags', '$schema',
    ...contentTypes.flatMap(type => [...type.fields])]);
  const primaryFields = Object.entries(primary).filter(([key, value]) => !ignored.has(key) && hasValue(value));
  const detailsIgnored = new Set(['rawoutput', 'readme', 'plugin', 'packagemanifest', 'manifest', 'contents',
    'metadatanotice', 'metadataerror', 'contentsnotice', 'contentsnotices', 'contentsnotes', 'name', 'version', 'description', 'tags', 'plugin']);
  const primaryKeys = new Set(Object.keys(primary).map(key => key.toLowerCase()));
  const additional = Object.entries(details ?? {}).filter(([key, value]) =>
    !detailsIgnored.has(key.toLowerCase()) && !primaryKeys.has(key.toLowerCase()) && hasValue(value)
  );
  if (primaryFields.length || additional.length) {
    const section = el('section', 'details-section');
    section.append(el('h2', '', 'Package information'), fieldList([...primaryFields, ...additional]));
    fragment.append(section);
  }
  return fragment;
}

const statusText: Record<ActionResult['status'], string> = { running: 'Running', success: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled' };
export function renderActionResult(result: ActionResult, cancel: () => void, navigate?: (id: string) => void): HTMLElement {
  const section = el('section', `action-result ${result.status}`);
  section.setAttribute('aria-live', 'polite');
  section.setAttribute('aria-busy', String(result.status === 'running'));
  const heading = el('div', 'action-result-heading');
  heading.append(el('h2', '', result.title), el('span', `badge status-${result.status}`, statusText[result.status]));
  if (result.status === 'running') {
    const stop = el('button', 'secondary', 'Cancel'); stop.type = 'button'; stop.addEventListener('click', cancel); heading.append(stop);
  }
  section.append(heading, el('code', 'action-command', result.command));
  if (result.status === 'running') section.append(el('p', 'muted', 'Running… live output is in the APM output channel.'));
  if (result.summary) section.append(el('p', 'action-summary', result.summary));
  if (result.audit?.stale) section.append(el('p', 'notice warning', 'This audit is stale. Run it again before relying on its findings or scan coverage.'));
  if (result.audit?.coverage) {
    const coverage = result.audit.coverage;
    const summary = el('div', 'audit-coverage');
    summary.append(el('h3', '', 'Scan coverage'), el('p', coverage.complete ? 'muted' : 'notice warning',
      coverage.complete ? 'Scan coverage is complete.' : 'Scan coverage is incomplete. This audit is not a clean result.'));
    const diagnostics = coverage.primitives.filter(entry => entry.status === 'incomplete' || entry.diagnostic);
    if (diagnostics.length) {
      const list = el('ul', 'coverage-diagnostics');
      for (const entry of diagnostics) {
        const row = el('li');
        row.append(el('strong', '', entry.file), el('span', 'muted', ` ${[entry.pointer, entry.target, entry.kind, entry.status].filter(Boolean).join(' - ')}`));
        if (entry.diagnostic) row.append(el('p', '', entry.diagnostic));
        list.append(row);
      }
      summary.append(list);
    }
    section.append(summary);
  }
  if (result.audit?.findings.length) {
    const list = el('ul', 'findings');
    for (const finding of result.audit.findings) {
      const entry = el('li'); entry.append(el('span', `badge severity-${finding.severity.toLowerCase()}`, finding.severity), el('strong', '', ` ${finding.file}`), el('span', 'muted', ` — ${finding.message}`));
      if (finding.navigationId && navigate) {
        const open = el('button', 'secondary', 'Open finding'); open.type = 'button'; open.addEventListener('click', () => navigate(finding.navigationId!)); entry.append(open);
      }
      const line = finding.pointer ? finding.decodedLine : finding.line;
      const column = finding.pointer ? finding.decodedColumn : finding.column;
      const location = [finding.pointer, line !== undefined ? `${finding.pointer ? 'decoded ' : 'line '}${line}${column !== undefined ? `:${column}` : ''}` : undefined].filter(Boolean).join(' ');
      if (location || finding.category) entry.append(el('p', 'muted', [location, finding.category].filter(Boolean).join(' - ')));
      if (finding.remediation) entry.append(el('p', '', `Remediation: ${finding.remediation}`));
      list.append(entry);
    }
    section.append(list);
  }
  if (result.output) {
    const output = el('details', 'action-output');
    output.open = result.status === 'failed' || !result.audit;
    output.append(el('summary', '', 'Command output'), el('pre', 'result', result.output));
    section.append(output);
  }
  return section;
}
