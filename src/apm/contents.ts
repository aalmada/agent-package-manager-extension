import { record } from './adapters';

export const contentTypes = [
  { key: 'skills', label: 'Skills', fields: ['skills'] },
  { key: 'agents', label: 'Agents', fields: ['agents'] },
  { key: 'instructions', label: 'Instructions', fields: ['instructions'] },
  { key: 'prompts', label: 'Prompts', fields: ['prompts'] },
  { key: 'commands', label: 'Commands', fields: ['commands'] },
  { key: 'hooks', label: 'Hooks', fields: ['hooks'] },
  { key: 'mcpServers', label: 'MCP servers', fields: ['mcpServers', 'mcp_servers'] },
  { key: 'lspServers', label: 'LSP servers', fields: ['lspServers', 'lsp_servers'] },
  { key: 'canvases', label: 'Canvases', fields: ['canvases'] },
  // Top-level "extensions" is the vendor-namespace map, so extensions are only discovered, never read from it.
  { key: 'extensions', label: 'Extensions', fields: [] },
  { key: 'outputStyles', label: 'Output styles', fields: ['outputStyles', 'output_styles'] }
] as const;

export type ContentKind = typeof contentTypes[number]['key'];
export interface ContentItem {
  name: string;
  path?: string;
  description?: string;
  navigationId?: string;
  locationKind?: 'source' | 'installed' | 'deployed';
}
export interface ContentGroup {
  kind: ContentKind;
  items: ContentItem[];
}

function nameFromPath(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  let name = parts.pop() ?? '';
  if (/^SKILL\.md$/i.test(name)) name = parts.pop() ?? name;
  return name.replace(/\.(?:agent|instructions|prompt|skill)\.md$/i, '').replace(/\.(?:md|json|ya?ml)$/i, '');
}

function declaredItem(value: unknown, key?: string): ContentItem | undefined {
  if (typeof value === 'string') {
    const path = value.trim();
    return path ? { name: key ?? nameFromPath(path), path } : undefined;
  }
  if (!record(value)) return key ? { name: key } : undefined;
  const path = typeof value.path === 'string' && value.path.trim() ? value.path.trim() : undefined;
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : key ?? (path ? nameFromPath(path) : '');
  if (!name) return undefined;
  const description = typeof value.description === 'string' && value.description.trim() ? value.description.trim() : undefined;
  return { name, ...(path ? { path } : {}), ...(description ? { description } : {}) };
}

function declaredItems(value: unknown): ContentItem[] {
  if (Array.isArray(value)) return value.flatMap(entry => {
    const item = declaredItem(entry);
    return item ? [item] : [];
  });
  if (record(value) && !('name' in value) && !('path' in value)) {
    return Object.entries(value).flatMap(([key, entry]) => {
      const item = declaredItem(entry, key);
      return item ? [item] : [];
    });
  }
  const item = declaredItem(value);
  return item ? [item] : [];
}

function itemKey(item: ContentItem): string {
  return item.path
    ? item.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').replace(/\/SKILL\.md$/i, '')
    : `name:${item.name}`;
}

export function mergeContents(...sources: readonly ContentGroup[][]): ContentGroup[] {
  const groups = new Map<ContentKind, Map<string, ContentItem>>();
  for (const source of sources) for (const group of source) {
    let items = groups.get(group.kind);
    if (!items) { items = new Map(); groups.set(group.kind, items); }
    for (const item of group.items) {
      const key = itemKey(item);
      const existing = items.get(key);
      items.set(key, existing ? {
        ...existing,
        ...(item.navigationId ? { navigationId: item.navigationId, locationKind: item.locationKind } : {}),
        ...(!existing.description && item.description ? { description: item.description } : {})
      } : item);
    }
  }
  return contentTypes.flatMap(({ key }) => {
    const items = groups.get(key);
    return items?.size ? [{ kind: key, items: [...items.values()] }] : [];
  });
}

export function declaredContents(...sources: unknown[]): ContentGroup[] {
  const groups: ContentGroup[] = [];
  for (const source of sources) {
    if (!record(source)) continue;
    for (const definition of contentTypes) {
      for (const field of definition.fields) {
        const items = declaredItems(source[field]);
        if (items.length) groups.push({ kind: definition.key, items });
      }
    }
  }
  return mergeContents(groups);
}

export const awesomeCopilotNamespace = 'com.github.awesome-copilot';

export function safeRepositoryPath(path: string): boolean {
  return !!path && !path.startsWith('/') && !path.includes('\\') && ![...path].some(character => character.charCodeAt(0) < 32) &&
    path.split('/').every(part => part && part !== '.' && part !== '..');
}

// Mirrors awesome-copilot's eng/materialize-plugins.mjs: entries look plugin-relative but resolve from the repository root.
function repositoryPath(kind: 'agents' | 'skills' | 'extensions' | 'hooks', value: string): string | undefined {
  const prefix = `./${kind}/`;
  if (!value.startsWith(prefix)) return undefined;
  const rest = value.slice(prefix.length).replace(/\/+$/, '');
  const path = kind === 'agents' ? `agents/${(rest.split('/').pop() ?? '').replace(/\.md$/i, '')}.agent.md` : `${kind}/${rest}`;
  return safeRepositoryPath(path) ? path : undefined;
}

/** Contents declared under extensions["com.github.awesome-copilot"], with repository-root paths. */
export function repositoryComposition(manifest: unknown): ContentGroup[] {
  if (!record(manifest) || !record(manifest.extensions)) return [];
  const composition = manifest.extensions[awesomeCopilotNamespace];
  if (!record(composition)) return [];
  const groups: ContentGroup[] = [];
  for (const kind of ['skills', 'agents', 'extensions', 'hooks'] as const) {
    const entries = composition[kind];
    if (!Array.isArray(entries)) continue;
    const items = entries.flatMap(entry => {
      const path = typeof entry === 'string' ? repositoryPath(kind, entry.trim()) : undefined;
      return path ? [{ name: nameFromPath(path), path }] : [];
    });
    if (items.length) groups.push({ kind, items });
  }
  return mergeContents(groups);
}

export const repositoryCompositionNote = 'Installing this plugin with APM will not install these contents. They are declared for awesome-copilot\'s ' +
  'published build and resolved here from the repository, but the plugin source folder contains only its manifest and README, which is all APM copies.';
