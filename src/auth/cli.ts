import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { record } from '../apm/adapters';
import { marketplaceManifest, readMarketplaces, readOptional } from '../apm/manifest';
import { marketplaceRepository, remoteSource } from '../apm/remoteMetadata';
import type { Marketplace } from '../apm/types';
import { repositoryFromSource, type Repository, type RepositoryHost } from './repositories';

export interface CliCredential {
  repository: Repository;
  token: string;
  username: string;
  scheme: 'basic' | 'bearer';
}

export interface CliAuthentication {
  hosts(): readonly RepositoryHost[];
  knownRepositories(): readonly Repository[];
  credentials(repositories: readonly Repository[], signal?: AbortSignal): Promise<readonly CliCredential[]>;
}

const localCommands = new Set(['config', 'compile', 'deps', 'view', 'init', 'target', 'runtime', 'uninstall', 'cache']);
const compatibilityError = 'This APM CLI cannot safely route different repository credentials within one operation. ' +
  'Package contents and README support separate accounts, but this operation requires upstream APM repository-credential routing. ' +
  'Use APM with repository-aware Git/SSH authentication outside the extension, or an account with access to all dependencies.';

function key(repository: Repository) {
  return `${repository.provider}:${repository.origin}/${repository.path}`;
}

/** Read-only context collection; APM remains responsible for dependency resolution. */
export async function cliEnvironment(authentication: CliAuthentication, args: readonly string[],
  cwd: string, home: string, signal?: AbortSignal): Promise<Record<string, string>> {
  signal?.throwIfAborted();
  if (!args.length || args.includes('--help') || args.includes('--version') || localCommands.has(args[0])) return {};
  // Scripts are project code, not repository authentication clients.
  if (args[0] === 'run') return {};
  if (args[0] === 'marketplace' && !['add', 'update', 'check'].includes(args[1])) return {};
  const registered = await readMarketplaces(home);
  const repositories = new Map<string, Repository>();
  const add = (source: unknown) => {
    if (typeof source !== 'string' || /^(?:file:|\/|\.\/|\.\.\/)/.test(source)) return;
    const repository = repositoryFromSource(source, authentication.hosts());
    if (repository) repositories.set(key(repository), repository);
  };
  const sourceOf = (value: unknown) => {
    if (typeof value === 'string') { expression(value); return; }
    if (!record(value)) return;
    if (typeof value.host === 'string' && typeof value.repo_url === 'string') {
      add(`https://${value.host}/${value.repo_url}`);
    } else for (const field of ['git', 'repo', 'repository', 'url', 'repo_url']) {
      if (typeof value[field] === 'string') add(value[field]);
    }
  };
  const addMarketplace = async (marketplace: Marketplace, pluginName?: string) => {
    if (!/^(?:file:|\/|\.\/|\.\.\/)/.test(marketplace.source)) {
      const repository = marketplaceRepository(marketplace, authentication.hosts());
      if (repository) repositories.set(key(repository), repository);
    }
    if (!pluginName) return;
    const snapshot = await marketplaceManifest(marketplace, home);
    const plugins = snapshot.manifest?.plugins;
    if (Array.isArray(plugins)) {
      const plugin = plugins.find(candidate => record(candidate) && candidate.name === pluginName);
      if (record(plugin)) {
        const source = remoteSource(plugin.source, marketplace, authentication.hosts());
        if (source) repositories.set(key(source.repository), source.repository);
      }
    }
  };
  const selectedMarketplaces = new Map<string, string | undefined>();
  function expression(value: string) {
    const match = /^([^/@:#]+)@([^/#]+)(?:#.*)?$/.exec(value);
    if (match) selectedMarketplaces.set(match[2], match[1]);
    else add(value);
  }
  if (args[0] === 'marketplace') {
    if (args[1] === 'add') add(args[2]);
    else for (const marketplace of registered.filter(entry => !args[2] || entry.name === args[2])) add(marketplace.source);
  } else {
    for (const arg of args.slice(1).filter(value => !value.startsWith('-'))) expression(arg);
    const root = args.includes('--global') ? join(home, '.apm') : cwd;
    for (const name of ['apm.yml', 'apm.lock.yaml']) {
      const text = await readOptional(join(root, name));
      if (text === undefined) continue;
      const document: unknown = parseYaml(text);
      if (!record(document)) throw new Error(`Cannot read authentication context from ${name}: expected an object.`);
      const dependencies = document.dependencies;
      if (Array.isArray(dependencies)) dependencies.forEach(sourceOf);
      else if (record(dependencies) && Array.isArray(dependencies.apm)) dependencies.apm.forEach(sourceOf);
    }
    for (const [name, plugin] of selectedMarketplaces) {
      const marketplace = registered.find(entry => entry.name === name);
      if (marketplace) await addMarketplace(marketplace, plugin);
    }
  }
  signal?.throwIfAborted();
  const selected = await authentication.credentials([...repositories.values()], signal);
  signal?.throwIfAborted();
  if (!selected.length) return {};
  const tokens = new Set(selected.map(credential => credential.token));
  const origins = new Set([...repositories.values()].map(repository => repository.origin));
  if (tokens.size > 1 || origins.size > 1 ||
    selected.some(credential => credential.repository.provider === 'azure' && credential.scheme === 'bearer')) {
    throw new Error(compatibilityError);
  }
  // Scoped marketplace operations have one concrete source. A resolver operation
  // can discover new repositories that the current CLI cannot credential-scope.
  if (args[0] !== 'marketplace') {
    const bindings = authentication.knownRepositories();
    if (bindings.some(repository => !repositories.has(key(repository))) || selected.some(credential => credential.repository.provider !== 'github' ||
      credential.repository.origin !== 'https://github.com')) throw new Error(compatibilityError);
  }
  const credential = selected[0];
  if (credential.repository.provider === 'github') {
    const environment: Record<string, string> = {};
    for (const name of Object.keys(process.env)) if (name.startsWith('GITHUB_APM_PAT_')) environment[name] = '';
    return { ...environment, GITHUB_APM_PAT: credential.token };
  }
  if (credential.repository.provider === 'gitlab') return { GITLAB_APM_PAT: credential.token };
  return { ADO_APM_PAT: credential.token };
}
