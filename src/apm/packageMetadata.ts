import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { record } from './adapters';
import { awesomeCopilotNamespace, declaredContents, mergeContents, nameFromPath, repositoryComposition, repositoryCompositionNote, safeRepositoryPath,
  type ContentGroup, type ContentItem, type ContentKind } from './contents';
import { listContained, readBareFile, readContained, resolveContained } from './manifest';
import { remoteReader, repositoryPath, type RemoteSource, type RemoteTree } from './remoteMetadata';
export { remoteSource, type RemoteSource } from './remoteMetadata';

export interface PackageMetadata {
  localRoot?: string;
  pluginManifest?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  readme?: string;
  contents: ContentGroup[];
  notices: string[];
  /** Informational context about the listed contents (not a loading problem). */
  notes?: string[];
}

const manifestPaths = ['.github/plugin/plugin.json', '.claude-plugin/plugin.json', 'plugin.json'];
const readmePaths = ['README.md', 'readme.md', 'Readme.md'];
const maxReadmeBytes = 2 * 1024 * 1024;
const maxDirectoryEntries = 1000;
const maxRemoteDescriptions = 250;
const remoteDescriptionConcurrency = 8;
const maxFrontmatterBytes = 64 * 1024;

// `marker` folders hold one directory per item, identified by the marker file inside it.
const contentFolders: { kind: ContentKind; path: string; marker?: RegExp; extension: RegExp }[] = [
  { kind: 'skills', path: '.apm/skills', marker: /^SKILL\.md$/i, extension: /\.md$/i },
  { kind: 'skills', path: 'skills', marker: /^SKILL\.md$/i, extension: /\.md$/i },
  { kind: 'skills', path: '.agents/skills', marker: /^SKILL\.md$/i, extension: /\.md$/i },
  { kind: 'skills', path: '.github/skills', marker: /^SKILL\.md$/i, extension: /\.md$/i },
  { kind: 'skills', path: '.claude/skills', marker: /^SKILL\.md$/i, extension: /\.md$/i },
  { kind: 'agents', path: '.apm/agents', extension: /\.md$/i },
  { kind: 'agents', path: '.github/agents', extension: /\.md$/i },
  { kind: 'agents', path: '.claude/agents', extension: /\.md$/i },
  { kind: 'agents', path: 'com.github.copilot/agents', extension: /\.md$/i },
  { kind: 'agents', path: 'agents', extension: /\.md$/i },
  { kind: 'instructions', path: '.apm/instructions', extension: /\.md$/i },
  { kind: 'instructions', path: '.github/instructions', extension: /\.md$/i },
  { kind: 'instructions', path: 'instructions', extension: /\.md$/i },
  { kind: 'prompts', path: '.apm/prompts', extension: /\.md$/i },
  { kind: 'prompts', path: '.github/prompts', extension: /\.md$/i },
  { kind: 'prompts', path: 'prompts', extension: /\.md$/i },
  { kind: 'commands', path: '.claude/commands', extension: /\.md$/i },
  { kind: 'commands', path: 'commands', extension: /\.md$/i },
  { kind: 'hooks', path: '.apm/hooks', extension: /\.(?:json|ya?ml)$/i },
  { kind: 'hooks', path: 'com.github.copilot/hooks', extension: /\.(?:json|ya?ml)$/i },
  { kind: 'hooks', path: 'hooks', extension: /\.(?:json|ya?ml)$/i },
  { kind: 'extensions', path: 'com.github.copilot/extensions', marker: /^extension\.m?js$/i, extension: /$^/ }
];

// Skills keep their SKILL.md path; other directory items are identified by the directory itself.
function markerItemPath(kind: ContentKind, directory: string, marker: string): string {
  return kind === 'skills' ? `${directory}/${marker}` : directory;
}

function parseObject(text: string, path: string, yaml = false): Record<string, unknown> {
  let value: unknown;
  try { value = yaml ? parseYaml(text) : JSON.parse(text); }
  catch (error) { throw new Error(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!record(value)) throw new Error(`${path} must contain an object.`);
  return value;
}

function frontmatter(text: string, path: string, notices: string[]): Partial<ContentItem> {
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
  if (!match) return {};
  let data: unknown;
  try { data = parseYaml(match[1]); }
  catch (error) {
    data = looseFrontmatter(match[1]);
    if (!record(data) || !Object.keys(data).length) {
      notices.push(`Could not read the description in ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }
  if (!record(data)) return {};
  return {
    ...(typeof data.name === 'string' && data.name.trim() ? { name: data.name.trim() } : {}),
    ...(typeof data.description === 'string' && data.description.trim() ? { description: data.description.trim() } : {})
  };
}

/**
 * Agent tools accept plain scalars that strict YAML rejects, such as `description: Use when: …`.
 * Read top-level `key: value` lines literally, joining indented continuation lines.
 */
function looseFrontmatter(text: string): Record<string, string> {
  const data: Record<string, string> = {};
  let key: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const entry = line.match(/^([A-Za-z_][\w-]*):(?:\s+(.*))?$/);
    if (entry) {
      key = entry[1];
      const value = (entry[2] ?? '').trim();
      data[key] = /^[|>][-+]?$/.test(value) ? '' : value.replace(/^(["'])(.*)\1$/, '$2');
    } else if (key && /^\s+\S/.test(line)) data[key] = `${data[key]} ${line.trim()}`.trim();
    else if (line.trim()) key = undefined;
  }
  return data;
}

async function localItem(root: string, path: string, notices: string[]): Promise<ContentItem | undefined> {
  const text = await readContained(root, path);
  if (text === undefined) return undefined;
  return { name: nameFromPath(path), path: path.replace(/\\/g, '/'), ...frontmatter(text, path, notices) };
}

async function localContents(root: string, notices: string[]): Promise<ContentGroup[]> {
  const groups: ContentGroup[] = [];
  try {
    const rootSkill = await localItem(root, 'SKILL.md', notices);
    if (rootSkill) groups.push({ kind: 'skills', items: [rootSkill] });
  } catch (error) {
    notices.push(`Could not read SKILL.md: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rootFiles = await listContained(root, '.');
  if (rootFiles) {
    const promptFiles = rootFiles.filter(entry => entry.isFile() && /\.prompt\.md$/i.test(entry.name));
    if (promptFiles.length > maxDirectoryEntries) notices.push(`The package contains more than ${maxDirectoryEntries} root prompts; the list is incomplete.`);
    const prompts = await Promise.allSettled(promptFiles.slice(0, maxDirectoryEntries).map(entry => localItem(root, entry.name, notices)));
    const items: ContentItem[] = [];
    for (let index = 0; index < prompts.length; index++) {
      const result = prompts[index];
      if (result.status === 'fulfilled' && result.value) items.push(result.value);
      if (result.status === 'rejected') notices.push(`Could not read ${promptFiles[index].name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
    if (items.length) groups.push({ kind: 'prompts', items });
  }
  const results = await Promise.allSettled(contentFolders.map(async folder => {
    const entries = await listContained(root, folder.path);
    if (!entries) return undefined;
    if (entries.length > maxDirectoryEntries) notices.push(`${folder.path} contains more than ${maxDirectoryEntries} entries; the list is incomplete.`);
    const items: ContentItem[] = [];
    for (const entry of entries.slice(0, maxDirectoryEntries)) {
      try {
        if (folder.marker) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const directory = await resolveContained(root, join(folder.path, entry.name));
          if (!directory || !(await stat(directory)).isDirectory()) continue;
          if (folder.kind === 'skills') {
            const item = await localItem(root, join(folder.path, entry.name, 'SKILL.md'), notices);
            if (item) items.push(item);
            continue;
          }
          const marker = (await listContained(root, join(folder.path, entry.name)))?.find(file => folder.marker!.test(file.name));
          if (!marker) continue;
          const path = markerItemPath(folder.kind, `${folder.path}/${entry.name}`, marker.name);
          const manifest = await readContained(root, join(path, 'package.json'));
          items.push({ name: entry.name, path, ...(manifest === undefined ? {} : describedBy(`${path}/package.json`, manifest, notices)) });
        } else if ((entry.isFile() || entry.isSymbolicLink()) && folder.extension.test(entry.name)) {
          const item = await localItem(root, join(folder.path, entry.name), notices);
          if (item) items.push(item);
        }
      } catch (error) {
        notices.push(`Could not read ${join(folder.path, entry.name)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { kind: folder.kind, items };
  }));
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status === 'fulfilled' && result.value?.items.length) groups.push(result.value);
    if (result.status === 'rejected') notices.push(`Could not list ${contentFolders[index].path}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  }
  return mergeContents(groups);
}

export function deployedContentKind(original: string): ContentKind | undefined {
  const path = original.replace(/\\/g, '/');
  const folder = contentFolders.find(folder => {
    if (!path.startsWith(`${folder.path}/`)) return false;
    const parts = path.slice(folder.path.length + 1).split('/');
    return folder.marker ? parts.length === 2 && folder.marker.test(parts[1]) :
      parts.length === 1 && folder.extension.test(parts[0]);
  });
  return folder?.kind ?? (/^[^/]+\.prompt\.md$/i.test(path) ? 'prompts' : undefined);
}

/** Inspect only this package's verified deployment files, not other workspace contents. */
export async function inspectDeployedPackage(root: string, paths: readonly string[]): Promise<PackageMetadata> {
  const notices: string[] = [], groups: ContentGroup[] = [];
  for (const path of paths) {
    const kind = deployedContentKind(path);
    if (!kind) continue;
    const item = await localItem(root, path, notices);
    if (item) groups.push({ kind, items: [item] });
  }
  return {
    localRoot: await resolveContained(root, '.'),
    contents: mergeContents(groups), notices,
    notes: ['This package is installed in its deployment directories but is not listed by the CLI. Only its verified deployed contents are shown; the package cache and README are unavailable.']
  };
}

interface RepositoryView {
  exists(path: string): Promise<boolean>;
  read(file: string): Promise<string | undefined>;
  origin: string;
}

async function mapBounded<T, R>(values: readonly T[], limit: number, map: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (let index = next++; index < values.length; index = next++) results[index] = await map(values[index]);
  }));
  return results;
}

/**
 * Adds contents declared under extensions["com.github.awesome-copilot"]. Without a repository view (e.g. an installed copy that
 * holds only the manifest) the declared names are still listed, but cannot be verified or described.
 */
async function addRepositoryComposition(pluginManifest: Record<string, unknown> | undefined, contents: ContentGroup[],
  notices: string[], notes: string[], repository?: RepositoryView): Promise<ContentGroup[]> {
  const namespace = record(pluginManifest?.extensions) ? pluginManifest.extensions[awesomeCopilotNamespace] : undefined;
  if (!record(namespace)) return contents;
  let groups = repositoryComposition(pluginManifest);
  if (repository) {
    // materialize-plugins.mjs also bundles extensions/<plugin name>/ when it exists, even if undeclared.
    const name = typeof pluginManifest?.name === 'string' ? pluginManifest.name.trim() : '';
    if (name && safeRepositoryPath(`extensions/${name}`) && await repository.exists(`extensions/${name}/extension.mjs`)) {
      groups = mergeContents(groups, [{ kind: 'extensions', items: [{ name, path: `extensions/${name}` }] }]);
    }
    let missing = 0;
    const checked: ContentGroup[] = [];
    for (const group of groups) {
      const present = await mapBounded(group.items, remoteDescriptionConcurrency,
        item => repository.exists(group.kind === 'extensions' ? item.path! : descriptionFile(group.kind, item.path) ?? item.path!));
      missing += present.filter(found => !found).length;
      checked.push({ kind: group.kind, items: group.items.filter((_, index) => present[index]) });
    }
    groups = checked.filter(group => group.items.length);
    if (missing) notices.push(`${missing} declared ${missing === 1 ? 'content was' : 'contents were'} not found in the repository.`);
    await describeContents(groups, repository.read, repository.origin, notices);
  }
  if (groups.length) notes.push(repositoryCompositionNote);
  return mergeContents(contents, groups);
}

export async function inspectLocalPackage(parent: string, path = '.', options: { repositoryRoot?: boolean } = {}): Promise<PackageMetadata> {
  const root = await resolveContained(parent, path);
  if (!root || !(await stat(root)).isDirectory()) throw new Error('The package source directory is not available.');
  const notices: string[] = [];
  const optional = async (name: string) => {
    try { return await readContained(root, name); }
    catch (error) { notices.push(`Could not read ${name}: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
  };
  const manifestTexts = await Promise.all(manifestPaths.map(optional));
  let pluginManifest: Record<string, unknown> | undefined;
  for (let index = 0; index < manifestTexts.length && !pluginManifest; index++) {
    if (manifestTexts[index] === undefined) continue;
    try { pluginManifest = parseObject(manifestTexts[index]!, manifestPaths[index]); }
    catch (error) { notices.push(error instanceof Error ? error.message : String(error)); }
  }
  const apmText = await optional('apm.yml');
  let manifest: Record<string, unknown> | undefined;
  try { if (apmText !== undefined) manifest = parseObject(apmText, 'apm.yml', true); }
  catch (error) { notices.push(error instanceof Error ? error.message : String(error)); }
  const readmes = await Promise.all(readmePaths.map(optional));
  let readme = readmes.find(text => text !== undefined);
  if (readme && Buffer.byteLength(readme) > maxReadmeBytes) { notices.push('README exceeds the 2 MB display limit.'); readme = undefined; }
  let discovered: ContentGroup[] = [];
  try { discovered = await localContents(root, notices); }
  catch (error) { notices.push(`Could not inspect package contents: ${error instanceof Error ? error.message : String(error)}`); }
  const contents = mergeContents(declaredContents(pluginManifest, manifest), discovered);
  const notes: string[] = [];
  const repository: RepositoryView | undefined = options.repositoryRoot ? {
    origin: 'the marketplace',
    exists: async file => { try { return !!(await resolveContained(parent, file)); } catch { return false; } },
    read: file => readContained(parent, file)
  } : undefined;
  return { localRoot: root, pluginManifest, manifest, readme, notices, notes,
    contents: await addRepositoryComposition(pluginManifest, contents, notices, notes, repository) };
}

export async function inspectBarePackage(gitDir: string, ref: string, path: string): Promise<PackageMetadata> {
  const prefix = repositoryPath(path);
  const paths = [...manifestPaths, 'apm.yml', 'README.md'];
  const texts = await Promise.all(paths.map(name => readBareFile(gitDir, ref, [prefix, name].filter(Boolean).join('/'))));
  const manifestIndex = texts.slice(0, manifestPaths.length).findIndex(text => text !== undefined);
  const pluginManifest = manifestIndex < 0 ? undefined : parseObject(texts[manifestIndex]!, manifestPaths[manifestIndex]);
  const manifest = texts[3] === undefined ? undefined : parseObject(texts[3], 'apm.yml', true);
  const notices = ['The package contents are based on manifest declarations; undeclared files may not be listed.'];
  const notes: string[] = [];
  const repository: RepositoryView = {
    origin: 'the marketplace cache',
    exists: async file => { try { return (await readBareFile(gitDir, ref, file)) !== undefined; } catch { return false; } },
    read: file => readBareFile(gitDir, ref, file)
  };
  const contents = await addRepositoryComposition(pluginManifest, declaredContents(pluginManifest, manifest), notices, notes, repository);
  return { pluginManifest, manifest, readme: texts[4], contents, notices, notes };
}

/** The file that carries an item's description: frontmatter for Markdown, package.json for extensions. */
function descriptionFile(kind: ContentKind, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const directory = path.replace(/\/+$/, '');
  if (kind === 'extensions') return `${directory}/package.json`;
  if (/\.md$/i.test(directory)) return directory;
  return kind === 'skills' ? `${directory}/SKILL.md` : undefined;
}

function describedBy(file: string, text: string, notices: string[]): Partial<ContentItem> {
  if (!/package\.json$/i.test(file)) return frontmatter(text, file, notices);
  try {
    const data: unknown = JSON.parse(text);
    return record(data) && typeof data.description === 'string' && data.description.trim() ? { description: data.description.trim() } : {};
  } catch (error) {
    notices.push(`Could not read the description in ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

/** Fills missing descriptions with bounded concurrency and a cap on requests; failures are summarized once. */
async function describeContents(groups: ContentGroup[], read: (file: string) => Promise<string | undefined>, origin: string,
  notices: string[]): Promise<ContentGroup[]> {
  const pending = groups.flatMap(group => group.items.flatMap(item => {
    const file = item.description ? undefined : descriptionFile(group.kind, item.path);
    return file ? [{ item, file, extension: group.kind === 'extensions' }] : [];
  }));
  const selected = pending.slice(0, maxRemoteDescriptions);
  let next = 0;
  const failures: string[] = [];
  await Promise.all(Array.from({ length: Math.min(remoteDescriptionConcurrency, selected.length) }, async () => {
    for (;;) {
      const target = selected[next++];
      if (!target) return;
      try {
        const text = await read(target.file);
        if (text === undefined) continue;
        const metadata = describedBy(target.file, text, notices);
        if (metadata.description) target.item.description = metadata.description;
        if (metadata.name && !target.extension) target.item.name = metadata.name;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
  }));
  if (pending.length > selected.length) notices.push(`Descriptions were not loaded for ${pending.length - selected.length} additional contents (limit: ${maxRemoteDescriptions}).`);
  if (failures.length) notices.push(`Could not load descriptions for ${failures.length} contents from ${origin}. ${failures[0]}`);
  return groups;
}

function remoteDescriptionReader(reader: Pick<ReturnType<typeof remoteReader>, 'read'>): (file: string) => Promise<string | undefined> {
  return file => reader.read(file, maxFrontmatterBytes, !/package\.json$/i.test(file));
}

function remoteTreeContents(tree: RemoteTree, source: RemoteSource): { contents: ContentGroup[]; truncated: boolean; blobs: Set<string> } {
  const groups: ContentGroup[] = [];
  const add = (kind: ContentKind, item: ContentItem) => groups.push({ kind, items: [item] });
  const blobs = new Set<string>();
  const prefix = source.path ? `${source.path}/` : '';
  for (const file of tree.paths) {
    blobs.add(file);
    if (!file.startsWith(prefix)) continue;
    const path = file.slice(prefix.length);
    if (path === 'SKILL.md') add('skills', { name: source.path.split('/').pop() || source.repository.path.split('/').pop()!, path });
    else if (!path.includes('/') && /\.prompt\.md$/i.test(path)) add('prompts', { name: nameFromPath(path), path });
    else for (const folder of contentFolders) {
      const folderPrefix = `${folder.path}/`;
      if (!path.startsWith(folderPrefix)) continue;
      const relative = path.slice(folderPrefix.length);
      if (folder.marker) {
        const match = relative.match(/^([^/]+)\/([^/]+)$/);
        if (match && folder.marker.test(match[2])) {
          const itemPath = markerItemPath(folder.kind, `${folder.path}/${match[1]}`, match[2]);
          add(folder.kind, { name: nameFromPath(itemPath), path: itemPath });
        }
      } else if (!relative.includes('/') && folder.extension.test(relative)) add(folder.kind, { name: nameFromPath(path), path });
      break;
    }
  }
  return { contents: mergeContents(groups), truncated: tree.truncated === true, blobs };
}

export async function inspectRemotePackage(source: RemoteSource, fetcher: typeof fetch = fetch): Promise<PackageMetadata> {
  const paths = [...manifestPaths, 'apm.yml', 'README.md'];
  const repositoryReader = remoteReader({ ...source, path: '' }, fetcher);
  const reader = {
    read: (file: string, limit?: number, frontmatter?: boolean) =>
      repositoryReader.read([repositoryPath(source.path), repositoryPath(file)].filter(Boolean).join('/'), limit, frontmatter),
    tree: repositoryReader.tree
  };
  const results = await Promise.allSettled([
    ...paths.map(path => reader.read(path, path === 'README.md' ? maxReadmeBytes : undefined)),
    reader.tree()
  ]);
  const notices: string[] = [];
  const allFailed = results.every(result => result.status === 'rejected');
  if (allFailed) {
    const first = results[0];
    if (first.status === 'rejected') notices.push(`Could not load package details from the repository host: ${first.reason instanceof Error ? first.reason.message : String(first.reason)}`);
  }
  const values = results.slice(0, paths.length).map((result, index) => {
    if (result.status === 'fulfilled') return result.value as string | undefined;
    if (!allFailed) notices.push(`Could not load ${paths[index] ?? 'repository listing'}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    return undefined;
  });
  const manifestIndex = values.slice(0, manifestPaths.length).findIndex(text => text !== undefined);
  let pluginManifest: Record<string, unknown> | undefined;
  let manifest: Record<string, unknown> | undefined;
  let discovered: ContentGroup[] = [];
  try { if (manifestIndex >= 0) pluginManifest = parseObject(values[manifestIndex]!, manifestPaths[manifestIndex]); }
  catch (error) { notices.push(error instanceof Error ? error.message : String(error)); }
  try { if (values[3] !== undefined) manifest = parseObject(values[3], 'apm.yml', true); }
  catch (error) { notices.push(error instanceof Error ? error.message : String(error)); }
  let blobs: Set<string> | undefined;
  try {
    const listing = results[5];
    if (listing.status === 'fulfilled' && listing.value !== undefined) {
      const tree = remoteTreeContents(listing.value as RemoteTree, source);
      discovered = tree.contents;
      if (tree.truncated) notices.push('The repository listing reached its display limit or was truncated; package contents may be incomplete.');
      else blobs = tree.blobs;
    } else if (listing.status === 'fulfilled') {
      notices.push('The repository listing is unavailable (HTTP 404). Check the repository, ref, and your account access.');
    } else if (!allFailed) {
      notices.push(`Could not load repository listing: ${listing.reason instanceof Error ? listing.reason.message : String(listing.reason)}`);
    }
  } catch (error) { notices.push(error instanceof Error ? error.message : String(error)); }
  let readme = values[4];
  if (readme === undefined && blobs) {
    const alternate = readmePaths.slice(1).find(path => blobs.has([source.path, path].filter(Boolean).join('/')));
    if (alternate) {
      try { readme = await reader.read(alternate, maxReadmeBytes); }
      catch (error) { notices.push(`Could not load ${alternate}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  if (!pluginManifest && !manifest && !discovered.length && !allFailed) notices.push('No package manifest or contents were found. Check the source path, ref, and your account access to the repository.');
  const contents = mergeContents(declaredContents(pluginManifest, manifest), discovered);
  await describeContents(contents, remoteDescriptionReader(reader), 'the repository host', notices);
  const notes: string[] = [];
  const withComposition = await addRepositoryComposition(pluginManifest, contents, notices, notes, {
    origin: 'the repository host',
    // An incomplete or unavailable listing cannot disprove existence; missing files then simply have no description.
    exists: async file => !blobs || blobs.has(file) || [...blobs].some(blob => blob.startsWith(`${file}/`)),
    read: remoteDescriptionReader(repositoryReader)
  });
  return { pluginManifest, manifest, readme, contents: withComposition, notices, notes };
}
