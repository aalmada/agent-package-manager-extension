import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { record } from '../apm/adapters';
import { containsUrlCredentials } from '../apm/redact';
import type { Marketplace } from '../apm/types';

/** One `apm.marketplaces` item: `[name=]source[#ref]`. */
export interface MarketplaceEntry { text: string; source: string; name?: string; ref?: string; local: boolean; relative?: boolean }

const NAMED = /^([A-Za-z0-9._-]+)=(.+)$/;
const DEFAULT_REF = 'main';
const relativePath = (source: string) => /^\.\.?(?:[\\/]|$)/.test(source);

function isLocal(source: string) {
  return source.startsWith('file://') || source.startsWith('/') || source.startsWith('~') || source.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/.test(source) || /^\.\.?(?:[\\/]|$)/.test(source);
}
function isJson(source: string) {
  try { return /\.json$/i.test(new URL(source).pathname); }
  catch { return /\.json$/i.test(source); }
}

export function parseEntry(value: string, workspaceRoot?: string): MarketplaceEntry {
  if (containsUrlCredentials(value)) throw new Error('Do not put passwords or access tokens in marketplace URLs. Remove them and use APM authentication.');
  const text = value.trim();
  if (!text) throw new Error('Marketplace entries cannot be empty.');
  if ([...text].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error(`"${text}" is not a valid marketplace source.`);
  const named = NAMED.exec(text);
  const name = named?.[1];
  let source = named ? named[2] : text;
  if (!source || source.startsWith('-')) throw new Error(`"${text}" is not a valid marketplace source.`);
  const local = isLocal(source);
  let ref: string | undefined;
  const relative = relativePath(source);
  if (local) {
    if (relative) {
      if (!workspaceRoot) throw new Error(`"${text}": a relative marketplace path requires exactly one local workspace folder; otherwise use an absolute path.`);
      source = resolve(workspaceRoot, source);
    }
    if (source.startsWith('~') && source !== '~' && !/^~[\\/]/.test(source)) throw new Error(`"${text}": use ~/path, not another user's home shorthand.`);
    if (source.startsWith('file://') && source.includes('#')) {
      try {
        const url = new URL(source);
        ref = decodeURIComponent(url.hash.slice(1));
        if (!ref) throw new Error('empty ref');
        url.hash = '';
        source = url.href;
      } catch {
        throw new Error(`"${text}" has an invalid or empty file URI #ref suffix.`);
      }
    }
  } else {
    if (/\s/.test(source)) throw new Error(`"${text}" is not a valid marketplace source.`);
    const hash = source.indexOf('#');
    if (hash >= 0) {
      ref = source.slice(hash + 1); source = source.slice(0, hash);
      if (!ref) throw new Error(`"${text}": the #ref suffix is empty.`);
      if (isJson(source)) throw new Error(`"${text}": marketplace.json URLs do not accept a #ref.`);
    }
  }
  if (!source) throw new Error(`"${text}" has no source.`);
  if (ref && isJson(source)) throw new Error(`"${text}": marketplace.json sources do not accept a #ref.`);
  try { location(source); } catch { throw new Error(`"${text}" is not a valid marketplace source.`); }
  return { text, source, local, ...(relative ? { relative } : {}), ...(name ? { name } : {}), ...(ref ? { ref } : {}) };
}

function localPath(source: string) {
  if (source.startsWith('file://')) return fileURLToPath(source);
  if (source === '~' || /^~[\\/]/.test(source)) return resolve(homedir(), source.slice(2));
  return source;
}

export function addArguments(entry: MarketplaceEntry): string[] {
  return ['marketplace', 'add', entry.local ? localPath(entry.source) : entry.source,
    ...(entry.name ? ['--name', entry.name] : []), ...(entry.ref ? ['--ref', entry.ref] : [])];
}

/** Normalized location so `owner/repo`, HTTPS, SSH and file URI spellings of one source compare equal. */
export function location(source: string): string {
  const value = source.trim();
  if (isLocal(value)) return `file:${resolve(localPath(value)).replace(/[\\/]+$/, '')}`;
  const normalize = (host: string, path: string, suffix = '') => {
    const hostname = host.toLowerCase();
    let normalizedPath = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    if (/^(?:github\.com|gitlab\.com|bitbucket\.org)(?::\d+)?$/.test(hostname)) normalizedPath = normalizedPath.toLowerCase();
    return `${hostname}/${normalizedPath}${suffix}`;
  };
  const scp = /^[^@/:\s]+@([^:/]+):(.+)$/.exec(value);
  if (scp) return normalize(scp[1], scp[2]);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const url = new URL(value);
    const defaultPort = (url.protocol === 'ssh:' && url.port === '22') || (url.protocol === 'git:' && url.port === '9418');
    const host = `${url.hostname}${url.port && !defaultPort ? `:${url.port}` : ''}`;
    if (isJson(value)) return `url:${url.protocol}//${host.toLowerCase()}${url.pathname}${url.search}`;
    return normalize(host, url.pathname, url.search);
  }
  if (/^[^/.]+\/[^/]+$/.test(value)) return normalize('github.com', value);
  const slash = value.indexOf('/');
  return slash < 0 ? value : normalize(value.slice(0, slash), value.slice(slash + 1));
}

function lastSegment(source: string) {
  if (isLocal(source)) return basename(localPath(source)).replace(/\.json$/i, '');
  return location(source).split('?')[0].split('/').pop()!.replace(/\.json$/i, '');
}

function supportsRef(source: string) { return !isJson(source); }

function transport(source: string): string | undefined {
  const scp = /^([^@/:\s]+)@[^:/]+:/.exec(source);
  if (scp) return `ssh:${scp[1]}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || isLocal(source)) return undefined;
  const url = new URL(source);
  return `${url.protocol}${url.username}`;
}

export function matches(entry: MarketplaceEntry, marketplace: Marketplace): boolean {
  if (location(entry.source) !== location(marketplace.source)) return false;
  const requestedTransport = transport(entry.source), registeredTransport = transport(marketplace.source);
  if (requestedTransport && registeredTransport && requestedTransport !== registeredTransport) return false;
  if (entry.name && entry.name.toLowerCase() !== marketplace.name.toLowerCase()) return false;
  return !supportsRef(entry.source) || (entry.ref ?? DEFAULT_REF) === (marketplace.ref || DEFAULT_REF);
}

/** The setting text that represents an existing registration. */
export function entryText(marketplace: Marketplace): string {
  const { source } = marketplace;
  const github = (marketplace.host ?? 'github.com').toLowerCase() === 'github.com'
    ? /^(?:https:\/\/github\.com\/|github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(source)?.slice(1).join('/')
    : undefined;
  let text = github ?? (isLocal(source) ? pathToFileURL(localPath(source)).href : source);
  if (supportsRef(source) && marketplace.ref && marketplace.ref !== DEFAULT_REF) {
    text += `#${isLocal(source) ? encodeURIComponent(marketplace.ref) : marketplace.ref}`;
  }
  if (marketplace.name !== lastSegment(source) && NAMED.test(`${marketplace.name}=x`)) text = `${marketplace.name}=${text}`;
  return text;
}

/** Relative paths become stable, host-specific file URIs after registration. */
export function resolvedText(entry: MarketplaceEntry): string {
  if (!entry.relative) return entry.text;
  return `${entry.name ? `${entry.name}=` : ''}${pathToFileURL(entry.source).href}${entry.ref ? `#${encodeURIComponent(entry.ref)}` : ''}`;
}

/** Convert one declaration from the previous structured setting without losing its APM options. */
export function legacyEntry(value: unknown, workspaceRoot?: string): string {
  if (!record(value) || typeof value.source !== 'string' || !value.source.trim()) throw new Error('A legacy marketplace entry needs a source.');
  for (const key of ['name', 'ref', 'branch', 'host']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`Legacy marketplace ${key} must be a string.`);
  }
  const ref = typeof value.ref === 'string' && value.ref ? value.ref : undefined;
  const branch = typeof value.branch === 'string' && value.branch ? value.branch : undefined;
  if (ref && branch) throw new Error('Legacy marketplace ref and branch cannot both be set.');
  let source = value.source.trim();
  const host = typeof value.host === 'string' ? value.host.trim() : '';
  if (host && !/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) throw new Error('Legacy marketplace host is invalid.');
  if (host && /^[^/:\s]+\/[^/:\s]+(?:#[^#]+)?$/.test(source)) source = `${host}/${source}`;
  const requestedRef = ref ?? branch;
  if (requestedRef) {
    if (isLocal(source) && !source.startsWith('file://')) {
      if (relativePath(source)) {
        if (!workspaceRoot) throw new Error('A legacy relative marketplace path requires exactly one local workspace folder.');
        source = pathToFileURL(resolve(workspaceRoot, source)).href;
      } else source = pathToFileURL(localPath(source)).href;
    }
    if (source.includes('#')) throw new Error('A legacy marketplace cannot combine a source #ref with ref or branch.');
    source += `#${isLocal(source) ? encodeURIComponent(requestedRef) : requestedRef}`;
  }
  if (typeof value.name === 'string' && value.name && !/^[A-Za-z0-9._-]+$/.test(value.name)) throw new Error('Legacy marketplace name is invalid.');
  const name = typeof value.name === 'string' && value.name ? `${value.name}=` : '';
  return resolvedText(parseEntry(`${name}${source}`, workspaceRoot));
}

export interface SyncPlan {
  /** Setting value after mirroring registry changes made outside VS Code. */
  setting: string[];
  /** Setting text → registered marketplace name. */
  links: Record<string, string>;
  add: MarketplaceEntry[];
  remove: string[];
  invalid: { text: string; error: string }[];
}

/**
 * Three-way merge between the setting, the APM registry and the last synchronized links.
 * Entries removed from the setting are unregistered; registrations removed outside VS Code are removed from the setting;
 * registrations added outside VS Code are appended to the setting.
 */
export function planSync(setting: readonly string[], registered: readonly Marketplace[], links: Readonly<Record<string, string>>, skip: ReadonlySet<string> = new Set(), workspaceRoot?: string): SyncPlan {
  const unsafe = registered.find(m => containsUrlCredentials(m.source));
  if (unsafe) throw new Error(`APM marketplace "${unsafe.name}" has credentials in its URL. Remove or replace that registration and use APM authentication before syncing marketplaces.`);
  const names = new Set(registered.map(m => m.name));
  const claimed = new Set<string>(), seen = new Set<string>(), present = new Set(setting.map(s => s.trim()));
  const plan: SyncPlan = { setting: [], links: {}, add: [], remove: [], invalid: [] };
  for (const raw of setting) {
    let entry: MarketplaceEntry;
    try { entry = parseEntry(raw, workspaceRoot); } catch (error) {
      plan.invalid.push({ text: raw, error: error instanceof Error ? error.message : String(error) }); plan.setting.push(raw); continue;
    }
    const identity = JSON.stringify([location(entry.source), entry.name?.toLowerCase() ?? '', supportsRef(entry.source) ? entry.ref ?? DEFAULT_REF : '']);
    const linked = links[entry.text];
    if (linked !== undefined && !names.has(linked)) continue;
    const registration = linked === undefined ? undefined : registered.find(m => m.name === linked);
    if (registration && !matches(entry, registration)) {
      const updated = entryText(registration);
      plan.setting.push(updated); plan.links[updated] = registration.name; claimed.add(registration.name); continue;
    }
    const text = resolvedText(entry);
    plan.setting.push(text);
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (linked !== undefined) { plan.links[text] = linked; claimed.add(linked); continue; }
    const match = registered.find(m => !claimed.has(m.name) && matches(entry, m));
    if (match) { plan.links[text] = match.name; claimed.add(match.name); continue; }
    if (!skip.has(entry.text)) plan.add.push(entry);
  }
  plan.remove = [...new Set(Object.entries(links).filter(([text]) => !present.has(text)).map(([, name]) => name))]
    .filter(name => names.has(name) && !claimed.has(name));
  for (const marketplace of registered) {
    if (claimed.has(marketplace.name) || plan.remove.includes(marketplace.name)) continue;
    const text = entryText(marketplace);
    plan.setting.push(text); plan.links[text] = marketplace.name; claimed.add(marketplace.name);
  }
  return plan;
}

/** Pick an explicit alias so registration cannot replace an unrelated marketplace's manifest-derived name. */
export function defaultName(entry: MarketplaceEntry): string {
  return entry.name ?? (lastSegment(entry.source).replace(/[^A-Za-z0-9._-]+/g, '-') || 'marketplace');
}
