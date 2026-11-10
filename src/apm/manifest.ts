import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { record } from './adapters';
import type { Marketplace } from './types';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const exec = promisify(execFile);
const safeName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^[._]+|[._]+$/g, '') || 'unnamed';

export async function readOptional(path: string): Promise<string | undefined> {
  try {
    if ((await stat(path)).size > 10 * 1024 * 1024) throw new Error('APM metadata exceeds the 10 MB safety limit.');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (record(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Reads APM's marketplace registry (current url and legacy owner/repo shapes) without writing it. */
export async function readMarketplaces(home: string): Promise<Marketplace[]> {
  const text = await readOptional(join(home, '.apm', 'marketplaces.json'));
  if (text === undefined) return [];
  const data: unknown = JSON.parse(text);
  if (!record(data) || !Array.isArray(data.marketplaces)) throw new Error('Invalid APM marketplace registry.');
  return data.marketplaces.map((entry: unknown) => {
    if (!record(entry) || typeof entry.name !== 'string') throw new Error('Invalid marketplace registration.');
    const host = typeof entry.host === 'string' ? entry.host : 'github.com';
    const source = typeof entry.url === 'string' && entry.url ? entry.url :
      typeof entry.owner === 'string' && typeof entry.repo === 'string' ?
        `${host === 'github.com' ? '' : `${host}/`}${entry.owner}/${entry.repo}` : '';
    if (!source) throw new Error(`Marketplace ${entry.name} has no readable source.`);
    return { ...entry, name: entry.name, source, ref: typeof entry.ref === 'string' ? entry.ref : typeof entry.branch === 'string' ? entry.branch : 'main', host };
  });
}

export const projectManifestName = 'apm.yml';
export function projectManifestPath(root: string): string { return join(root, projectManifestName); }
/** Reads the project manifest fresh from disk; cached presence state may be stale. */
export function readProjectManifest(root: string): Promise<string | undefined> { return readOptional(projectManifestPath(root)); }
export async function hasProjectManifest(root: string): Promise<boolean> { return await readProjectManifest(root) !== undefined; }

export async function resolveContained(root: string, path: string): Promise<string | undefined> {
  const resolvedRoot = await realpath(root), candidate = resolve(resolvedRoot, path);
  const lexical = relative(resolvedRoot, candidate);
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new Error('Manifest path escapes its marketplace.');
  let actual: string;
  try { actual = await realpath(candidate); }
  catch (error) { if (record(error) && error.code === 'ENOENT') return undefined; throw error; }
  const rel = relative(resolvedRoot, actual);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Manifest symlink escapes its marketplace.');
  return actual;
}

export async function readContained(root: string, path: string): Promise<string | undefined> {
  const actual = await resolveContained(root, path);
  return actual === undefined ? undefined : readOptional(actual);
}

export async function listContained(root: string, path: string): Promise<Dirent[] | undefined> {
  const actual = await resolveContained(root, path);
  return actual === undefined ? undefined : readdir(actual, { withFileTypes: true });
}

// Mirrors APM 0.35.0's URL-derived cache identity; never used for resolution/auth.
export function cacheShard(source: string): string {
  const scp = source.match(/^([a-zA-Z0-9_][a-zA-Z0-9_.+-]*)@([^:/[\]]+):([^?]+)$/);
  const url = new URL(scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3].replace(/^\//, '')}` : source);
  const hostname = url.hostname.toLowerCase();
  let path = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  if (['github.com', 'gitlab.com', 'bitbucket.org'].includes(hostname)) path = path.toLowerCase();
  const port = url.port && !((url.protocol === 'ssh:' && url.port === '22') || (url.protocol === 'git:' && url.port === '9418')) ? `:${url.port}` : '';
  return hash(`${url.protocol}//${url.username ? `${url.username}@` : ''}${hostname}${port}${path}`).slice(0, 16);
}
function cacheRoot(home: string): string {
  if (process.env.APM_CACHE_DIR) return process.env.APM_CACHE_DIR;
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'apm', 'Cache');
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, 'apm');
  return platform() === 'darwin' ? join(home, 'Library', 'Caches', 'apm') : join(home, '.cache', 'apm');
}
function parseManifest(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!record(parsed) || !Array.isArray(parsed.plugins)) throw new Error('Marketplace manifest has no plugins array.');
  return parsed;
}

export async function readBareFile(path: string, ref: string, filename: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || filename.startsWith('/') || filename.split(/[\\/]/).includes('..')) throw new Error('Unsafe marketplace ref or path.');
  try {
    const result = await exec('git', ['--git-dir', path, 'show', '--no-ext-diff', '--no-textconv', `${ref}:${filename}`], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' }, timeout: 15_000, maxBuffer: 10 * 1024 * 1024
    });
    return result.stdout;
  } catch (error) {
    if (record(error) && typeof error.stderr === 'string' && /does not exist in|exists on disk, but not in/.test(error.stderr)) return undefined;
    throw error;
  }
}

export async function marketplaceManifest(marketplace: Marketplace, home: string): Promise<{ manifest?: Record<string, unknown>; root?: string; gitDir?: string; ref?: string; notice?: string }> {
  const source = marketplace.source;
  const paths = [...new Set([typeof marketplace.path === 'string' ? marketplace.path : 'marketplace.json', 'marketplace.json', '.github/plugin/marketplace.json', '.claude-plugin/marketplace.json'])];
  if (isAbsolute(source) || source.startsWith('file://')) {
    const path = source.startsWith('file://') ? fileURLToPath(source) : source;
    if ((await stat(path)).isFile()) return { manifest: parseManifest((await readOptional(path))!), root: resolve(path, '..') };
    for (const candidate of paths) {
      const text = await readContained(path, candidate);
      if (text !== undefined) return { manifest: parseManifest(text), root: path };
    }
    for (const candidate of paths) {
      const text = await readBareFile(path, marketplace.ref ?? 'main', candidate);
      if (text !== undefined) return { manifest: parseManifest(text), gitDir: path, ref: marketplace.ref ?? 'main' };
    }
    return { notice: 'No manifest was found in the local marketplace snapshot.' };
  }
  const host = marketplace.host ?? 'github.com';
  const candidates = [
    marketplace.name, `${safeName(host)}__${marketplace.name}`,
    `git__${safeName(host)}__${safeName(marketplace.name)}`,
    `ado__${safeName(host)}__${safeName(marketplace.name)}`,
    `url__${hash(source).slice(0, 16)}`
  ];
  for (const key of candidates) {
    const text = await readOptional(join(home, '.apm', 'cache', 'marketplace', `${safeName(key)}.json`));
    if (text !== undefined) return { manifest: parseManifest(text) };
  }
  if (process.env.APM_NO_CACHE && ['1', 'true', 'yes'].includes(process.env.APM_NO_CACHE)) return { notice: 'APM has caching disabled. Only CLI-provided entry metadata is available.' };
  const shard = cacheShard(source);
  const root = cacheRoot(home);
  const ref = marketplace.ref ?? 'main';
  const sha = /^[a-f0-9]{40}$/i.test(ref) ? ref : await readOptional(join(root, 'git', 'db_v1', `${shard}-${hash(ref)}.ref`));
  if (sha && /^[a-f0-9]{40}$/i.test(sha)) {
    const shaRoot = join(root, 'git', 'checkouts_v1', shard, sha);
    let variants: string[];
    try { variants = await readdir(shaRoot); }
    catch (error) { if (record(error) && error.code === 'ENOENT') return { notice: 'The CLI checkout was evicted; refresh the marketplace to reload full metadata.' }; throw error; }
    for (const variant of variants) for (const candidate of paths) {
      const text = await readContained(join(shaRoot, variant), candidate);
      if (text !== undefined) return { manifest: parseManifest(text), root: join(shaRoot, variant) };
    }
  }
  return { notice: 'No persistent marketplace manifest snapshot is available for this transport/version. Only CLI-provided entry metadata is available.' };
}
