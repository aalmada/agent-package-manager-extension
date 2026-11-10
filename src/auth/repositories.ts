export type Repository = { provider: 'github' | 'gitlab' | 'azure'; origin: string; path: string };
export type RepositoryHost = Pick<Repository, 'origin' | 'provider'>;

const defaults: readonly RepositoryHost[] = [
  { origin: 'https://github.com', provider: 'github' },
  { origin: 'https://gitlab.com', provider: 'gitlab' },
  { origin: 'https://dev.azure.com', provider: 'azure' }
];

export function repositoryHosts(hosts: readonly RepositoryHost[] = []): readonly RepositoryHost[] {
  return [...defaults, ...hosts.filter(host => validOrigin(host.origin) && !defaults.some(item => item.origin === host.origin))];
}

export function validOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && !url.username && !url.password && url.origin === origin;
  } catch { return false; }
}

function safePath(path: string, spaces = false): boolean {
  return path.split('/').every(part => !!part && !['.', '..'].includes(part) &&
    (spaces ? /^[\w .-]+$/ : /^[\w.-]+$/).test(part));
}

export function repositoryFromSource(source: string, hosts: readonly RepositoryHost[] = []): Repository | undefined {
  if (!source || /[\\\t\r\n?]/.test(source)) return undefined;
  let value = source.split('#')[0].replace(/\/$/, '').replace(/\.git$/, '');
  const qualified = /^([^/:]+)\/(.+)$/.exec(value);
  if (qualified && repositoryHosts(hosts).some(host => new URL(host.origin).host === qualified[1])) value = `https://${value}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) value = `https://github.com/${value}`;
  const scp = /^git@([^/:]+):(.+)$/.exec(value);
  if (scp) value = `https://${scp[1]}/${scp[2]}`;
  else if (value.startsWith('ssh://')) {
    if (!/^ssh:\/\/git@[^/]+\/.+$/.test(value)) return undefined;
    value = value.replace(/^ssh:\/\/git@/, 'https://');
  }
  const azureSsh = /^https:\/\/ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(value);
  if (azureSsh) value = `https://dev.azure.com/${azureSsh[1]}/${azureSsh[2]}/_git/${azureSsh[3]}`;
  // Check before URL parsing, which would otherwise normalize traversal away.
  const rawPath = value.match(/^https:\/\/[^/]+\/(.*)$/)?.[1];
  if (!rawPath || /%2f|%5c/i.test(rawPath)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    const host = repositoryHosts(hosts).find(item => item.origin === url.origin);
    if (!host) return undefined;
    const path = rawPath.split('/').map(part => decodeURIComponent(part)).join('/');
    if (!safePath(path, host.provider === 'azure')) return undefined;
    const parts = path.split('/');
    if (host.provider === 'github' && parts.length !== 2) return undefined;
    if (host.provider === 'gitlab' && parts.length < 2) return undefined;
    if (host.provider === 'azure') {
      const legacy = url.hostname.endsWith('.visualstudio.com');
      if (legacy ? parts.length !== 3 || parts[1] !== '_git' : parts.length !== 4 || parts[2] !== '_git') return undefined;
    }
    return { ...host, path };
  } catch { return undefined; }
}

export function repositoryProbeUrl(repository: Repository): string {
  const { origin, path, provider } = repository;
  if (provider === 'github') return `${origin === 'https://github.com' ? 'https://api.github.com' : origin + '/api/v3'}/repos/${path}`;
  if (provider === 'gitlab') return `${origin}/api/v4/projects/${encodeURIComponent(path)}`;
  const parts = path.split('/').map(part => encodeURIComponent(part));
  const repo = parts.pop();
  parts.pop();
  return `${origin}/${parts.join('/')}/_apis/git/repositories/${repo}?api-version=7.1`;
}

export function repositoryForRequest(url: URL, hosts: readonly RepositoryHost[] = []): Repository | undefined {
  if (url.protocol !== 'https:' || url.username || url.password || /%2e|%5c/i.test(url.pathname)) return undefined;
  let source: string | undefined;
  if (url.origin === 'https://raw.githubusercontent.com') {
    const parts = url.pathname.slice(1).split('/');
    if (parts.length >= 4) source = `https://github.com/${parts.slice(0, 2).join('/')}`;
  } else {
    for (const host of repositoryHosts(hosts)) {
      if (host.provider === 'github') {
        const api = host.origin === 'https://github.com' ? 'https://api.github.com' : host.origin;
        const prefix = host.origin === 'https://github.com' ? '' : '/api/v3';
        if (url.origin !== api) continue;
        const match = new RegExp(`^${prefix}/repos/([^/]+/[^/]+)(?:/(?:contents(?:/.*)?|git/(?:trees|blobs)/[^/]+|readme))?/?$`).exec(url.pathname);
        if (match) source = `${host.origin}/${match[1]}`;
      } else if (host.provider === 'gitlab' && url.origin === host.origin) {
        const match = /^\/api\/v4\/projects\/([^/]+)(?:\/repository\/(?:files\/[^/]+(?:\/raw)?|tree))?\/?$/.exec(url.pathname);
        if (match) {
          try { source = `${host.origin}/${decodeURIComponent(match[1])}`; } catch { return undefined; }
        }
      } else if (host.provider === 'azure' && url.origin === host.origin) {
        const match = /^\/(.+)\/_apis\/git\/repositories\/([^/]+)(?:\/(?:items|trees|blobs)(?:\/[^/]+)?)?\/?$/.exec(url.pathname);
        if (match) source = `${host.origin}/${match[1]}/_git/${match[2]}`;
      }
      if (source) break;
    }
  }
  return source ? repositoryFromSource(source, hosts) : undefined;
}

export function repositoryKey(repository: Repository): string {
  return `${repository.provider}:${repository.origin}/${repository.path}`;
}
