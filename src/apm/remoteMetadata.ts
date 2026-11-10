import { repositoryFromSource, type Repository, type RepositoryHost } from '../auth/repositories';
import { record } from './adapters';
import type { Marketplace } from './types';

export interface RemoteSource { repository: Repository; path: string; ref: string }
export interface RemoteTree { paths: string[]; truncated: boolean }
const maxTreeBytes = 5 * 1024 * 1024;
const maxTreeEntries = 50_000;
const maxTreePages = 100;
const maxFrontmatterBytes = 64 * 1024;
const hasControlCharacters = (value: string) => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export function repositoryPath(path: string): string {
  if (path.startsWith('/')) throw new Error('The plugin source contains an unsafe repository path.');
  const normalized = path.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.') return '';
  if (normalized.startsWith('/') || normalized.includes('\\') || hasControlCharacters(normalized) ||
      normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('The plugin source contains an unsafe repository path.');
  }
  return normalized;
}

export function marketplaceRepository(marketplace: Marketplace, hosts?: readonly RepositoryHost[]): Repository | undefined {
  return repositoryFromSource(repositoryLocation(marketplace.source, marketplace.host, hosts), hosts);
}

/** Resolve only built-in providers or explicitly approved enterprise origins. */
export function remoteSource(source: unknown, marketplace: Marketplace, hosts?: readonly RepositoryHost[]): RemoteSource | undefined {
  const parent = marketplaceRepository(marketplace, hosts);
  if (typeof source === 'string') {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source) || source.includes('@')) return undefined;
    const repository = parent;
    return repository ? { repository, path: repositoryPath(source), ref: repositoryRef(marketplace.ref || fragmentRef(marketplace.source) || 'HEAD') } : undefined;
  }
  if (!record(source)) return undefined;
  const kind = source.source ?? source.type ?? source.kind;
  if (typeof kind !== 'string' || !['github', 'git', 'git-subdir', 'gitlab', 'azure', 'azure-devops'].includes(kind.toLowerCase())) return undefined;
  const locationValue = [source.url, source.repo, source.repository].find(value => typeof value === 'string') as string | undefined;
  if (!locationValue) return undefined;
  const provider = kind.toLowerCase().startsWith('azure') ? 'azure' : kind.toLowerCase();
  const hint = typeof source.host === 'string' ? source.host :
    parent?.provider === provider ? new URL(parent.origin).host : provider === 'gitlab' ? 'gitlab.com' : undefined;
  const location = repositoryLocation(locationValue, hint, hosts);
  const repository = repositoryFromSource(location, hosts);
  if (!repository) return undefined;
  if (['github', 'gitlab', 'azure', 'azure-devops'].includes(kind.toLowerCase()) &&
      repository.provider !== (kind.toLowerCase().startsWith('azure') ? 'azure' : kind.toLowerCase())) return undefined;
  const path = typeof source.path === 'string' ? source.path : typeof source.subdir === 'string' ? source.subdir : '';
  const ref = typeof source.sha === 'string' && /^[a-f0-9]{40}$/i.test(source.sha) ? source.sha :
    typeof source.ref === 'string' && source.ref ? source.ref : fragmentRef(location) || 'HEAD';
  return { repository, path: repositoryPath(path), ref: repositoryRef(ref) };
}

function repositoryLocation(location: string, hint: string | undefined, hosts: readonly RepositoryHost[] = []): string {
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|git@)/.test(location)) return location;
  const knownHosts = ['github.com', 'gitlab.com', 'dev.azure.com', ...hosts.map(host => {
    try { return new URL(host.origin).host; } catch { return ''; }
  })];
  if (!hint || knownHosts.some(host => host && location.startsWith(`${host}/`))) return location;
  return `${(hint.includes('://') ? hint : `https://${hint}`).replace(/\/+$/, '')}/${location.replace(/^\/+/, '')}`;
}

function repositoryRef(ref: string): string {
  if (ref.length > 1024 || hasControlCharacters(ref)) throw new Error('The plugin source contains an unsafe repository ref.');
  return ref;
}

function fragmentRef(source: string): string | undefined {
  const fragment = source.indexOf('#');
  if (fragment < 0) return undefined;
  try { return decodeURIComponent(source.slice(fragment + 1)) || undefined; }
  catch { throw new Error('The plugin source contains an invalid repository ref.'); }
}

function apiRoot(repository: Repository): string {
  if (repository.provider === 'github') {
    return `${repository.origin === 'https://github.com' ? 'https://api.github.com' : `${repository.origin}/api/v3`}/repos/${repository.path.split('/').map(encodeURIComponent).join('/')}`;
  }
  if (repository.provider === 'gitlab') return `${repository.origin}/api/v4/projects/${encodeURIComponent(repository.path)}/repository`;
  const parts = repository.path.split('/');
  const marker = parts.indexOf('_git');
  if (marker < 1 || marker !== parts.length - 2) throw new Error('The Azure DevOps repository path is invalid.');
  return `${repository.origin}/${parts.slice(0, marker).map(encodeURIComponent).join('/')}/_apis/git/repositories/${encodeURIComponent(parts[marker + 1])}`;
}

function azureVersion(url: URL, ref: string): void {
  url.searchParams.set('api-version', '7.1');
  if (ref === 'HEAD') return;
  const commit = /^[a-f0-9]{40}$/i.test(ref);
  url.searchParams.set('versionDescriptor.versionType', commit ? 'commit' : ref.startsWith('refs/tags/') ? 'tag' : 'branch');
  url.searchParams.set('versionDescriptor.version', commit ? ref : ref.replace(/^refs\/(?:heads|tags)\//, ''));
}

function fileUrl(source: RemoteSource, file: string): URL {
  const path = repositoryPath([source.path, repositoryPath(file)].filter(Boolean).join('/'));
  const root = apiRoot(source.repository);
  const provider = source.repository.provider;
  const url = new URL(provider === 'github' ? `${root}/contents/${path.split('/').map(encodeURIComponent).join('/')}` :
    provider === 'gitlab' ? `${root}/files/${encodeURIComponent(path)}/raw` : `${root}/items`);
  if (provider === 'azure') {
    url.searchParams.set('path', `/${path}`);
    url.searchParams.set('download', 'true');
    azureVersion(url, source.ref);
  } else url.searchParams.set('ref', source.ref);
  return url;
}

async function request(url: URL, name: string, fetcher: typeof fetch, raw = false): Promise<Response> {
  const response = await fetcher(url.toString(), {
    signal: AbortSignal.timeout(10_000), redirect: 'error', credentials: 'omit',
    headers: { Accept: raw && (url.hostname === 'api.github.com' || url.pathname.startsWith('/api/v3/')) ?
      'application/vnd.github.raw+json' : raw ? 'application/octet-stream' : 'application/json' }
  });
  if (response.status !== 404 && !response.ok) {
    await response.body?.cancel();
    throw new Error(`The repository host returned HTTP ${response.status} for ${name}.${response.status === 401 || response.status === 403 ?
      ' Sign in to the repository host and check that your account has repository access.' : ''}`);
  }
  return response;
}

async function responseText(response: Response, name: string, limit: number, frontmatter = false): Promise<string | undefined> {
  if (response.status === 404) { await response.body?.cancel(); return undefined; }
  if (!frontmatter && Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error(`${name} exceeds the display size limit.`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      // Read only the bounded prefix even when the server sends the entire file in one chunk.
      text += decoder.decode(value.subarray(0, Math.max(0, limit - (size - value.byteLength))), { stream: true });
      if (frontmatter) {
        if (text.length >= 5 && !/^---\r?\n/.test(text)) { await reader.cancel(); return undefined; }
        const match = text.match(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\s*\r?\n|$)/);
        if (match) { await reader.cancel(); return match[0]; }
      }
      if (size > limit) {
        await reader.cancel();
        throw new Error(frontmatter ? `Frontmatter in ${name} exceeds the 64 KB display limit.` : `${name} exceeds the display size limit.`);
      }
    }
  } finally { reader.releaseLock(); }
}

export function remoteReader(source: RemoteSource, fetcher: typeof fetch): {
  read: (file: string, limit?: number, frontmatter?: boolean) => Promise<string | undefined>;
  tree: () => Promise<RemoteTree | undefined>;
} {
  let listing: Promise<RemoteTree | undefined> | undefined;
  const tree = () => listing ??= loadTree();
  const loadTree = async (): Promise<RemoteTree | undefined> => {
    const provider = source.repository.provider, root = apiRoot(source.repository);
    const paths: string[] = [];
    let bytes = 0;
    for (let page = 1; page <= maxTreePages; page++) {
      const url = new URL(provider === 'github' ? `${root}/git/trees/${encodeURIComponent(source.ref)}` :
        provider === 'gitlab' ? `${root}/tree` : `${root}/items`);
      if (provider === 'github') url.searchParams.set('recursive', '1');
      else if (provider === 'gitlab') {
        url.searchParams.set('recursive', 'true'); url.searchParams.set('ref', source.ref);
        url.searchParams.set('per_page', '100'); url.searchParams.set('page', String(page));
      } else {
        url.searchParams.set('scopePath', '/'); url.searchParams.set('recursionLevel', 'Full');
        url.searchParams.set('includeContentMetadata', 'true'); azureVersion(url, source.ref);
      }
      const response = await request(url, 'repository listing', fetcher);
      const text = await responseText(response, 'repository listing', maxTreeBytes - bytes);
      if (text === undefined) return undefined;
      bytes += Buffer.byteLength(text);
      const data: unknown = JSON.parse(text);
      const entries: unknown = provider === 'gitlab' ? data : record(data) ? provider === 'github' ? data.tree : data.value : undefined;
      if (!Array.isArray(entries)) throw new Error('The repository host returned an invalid repository listing.');
      for (const entry of entries) {
        if (!record(entry) || typeof entry.path !== 'string') continue;
        if (provider === 'azure' ? entry.gitObjectType !== 'blob' || entry.isFolder === true : entry.type !== 'blob') continue;
        const path = provider === 'azure' ? entry.path.replace(/^\//, '') : entry.path;
        if (!path || repositoryPath(path) !== path) throw new Error('The repository host returned an unsafe file path.');
        paths.push(path);
        if (paths.length >= maxTreeEntries) return { paths, truncated: true };
      }
      const next = response.headers.get('x-next-page');
      if (provider !== 'gitlab') return {
        paths, truncated: (record(data) && data.truncated === true) || !!response.headers.get('x-ms-continuationtoken')
      };
      if (next !== null ? next === '' : entries.length < 100) return { paths, truncated: false };
      if (next && next !== String(page + 1)) throw new Error('The repository host returned invalid tree pagination.');
    }
    return { paths, truncated: true };
  };
  return {
    read: async (file, limit = 1024 * 1024, frontmatter = false) => {
      if (source.repository.provider === 'azure') {
        const files = await tree();
        if (!files || files.truncated) throw new Error('Cannot verify the exact Azure DevOps file path because the repository listing is unavailable or incomplete.');
        const path = repositoryPath([repositoryPath(source.path), repositoryPath(file)].filter(Boolean).join('/'));
        if (!files.paths.includes(path)) return undefined;
      }
      return responseText(await request(fileUrl(source, file), file, fetcher, true),
        file, frontmatter ? maxFrontmatterBytes : limit, frontmatter);
    },
    tree
  };
}
