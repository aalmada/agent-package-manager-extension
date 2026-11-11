import { join } from 'node:path';
import { record } from '../apm/adapters';
import { marketplaceManifest, readMarketplaces } from '../apm/manifest';
import { marketplaceRepository, remoteSource } from '../apm/remoteMetadata';
import type { Marketplace } from '../apm/types';
import { repositoryFromSource, repositoryFromPackageSource, repositoryKey, type Repository, type RepositoryHost } from './repositories';
import { dependencyExpressions } from './dependencies';

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
  const add = (source: unknown, packageSource = false) => {
    if (typeof source !== 'string' || /^(?:file:|\/|\.\/|\.\.\/)/.test(source)) return;
    const repository = packageSource ? repositoryFromPackageSource(source, authentication.hosts()) : repositoryFromSource(source, authentication.hosts());
    if (repository) repositories.set(repositoryKey(repository), repository);
  };
  const addMarketplace = async (marketplace: Marketplace, pluginName?: string) => {
    if (!/^(?:file:|\/|\.\/|\.\.\/)/.test(marketplace.source)) {
      const repository = marketplaceRepository(marketplace, authentication.hosts());
      if (repository) repositories.set(repositoryKey(repository), repository);
    }
    if (!pluginName) return;
    const snapshot = await marketplaceManifest(marketplace, home);
    const plugins = snapshot.manifest?.plugins;
    if (Array.isArray(plugins)) {
      const plugin = plugins.find(candidate => record(candidate) && candidate.name === pluginName);
      if (record(plugin)) {
        const source = remoteSource(plugin.source, marketplace, authentication.hosts());
        if (source) repositories.set(repositoryKey(source.repository), source.repository);
      }
    }
  };
  const selectedMarketplaces = new Map<string, string | undefined>();
  function expression(value: string) {
    const match = /^([^/@:#]+)@([^/#]+)(?:#.*)?$/.exec(value);
    if (match) selectedMarketplaces.set(match[2], match[1]);
    else add(value, true);
  }
  if (args[0] === 'marketplace') {
    if (args[1] === 'add') add(args[2]);
    else for (const marketplace of registered.filter(entry => !args[2] || entry.name === args[2])) add(marketplace.source);
  } else {
    for (const arg of args.slice(1).filter(value => !value.startsWith('-'))) expression(arg);
    const root = args.includes('--global') ? join(home, '.apm') : cwd;
    for (const dependency of await dependencyExpressions(root)) expression(dependency);
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
  const describe = (entries: readonly Repository[]) => entries.map(repository => `${repository.origin}/${repository.path}`).join(', ');
  if (tokens.size > 1) throw new Error(`${compatibilityError} Different credentials are required by: ${describe(selected.map(entry => entry.repository))}.`);
  if (origins.size > 1) throw new Error(`${compatibilityError} Multiple repository origins are involved: ${describe([...repositories.values()])}.`);
  if (selected.some(credential => credential.repository.provider === 'azure' && credential.scheme === 'bearer')) {
    throw new Error(`${compatibilityError} Azure bearer credentials are not supported by this CLI.`);
  }
  // Scoped marketplace operations have one concrete source. A resolver operation
  // can discover new repositories that the current CLI cannot credential-scope.
  if (args[0] !== 'marketplace') {
    const bindings = authentication.knownRepositories();
    const outside = bindings.filter(repository => !repositories.has(repositoryKey(repository)));
    if (outside.length) throw new Error(`${compatibilityError} Saved bindings outside this operation: ${describe(outside)}.`);
    const unsupported = selected.filter(credential => credential.repository.provider !== 'github' || credential.repository.origin !== 'https://github.com');
    if (unsupported.length) throw new Error(`${compatibilityError} Resolver credentials are unsupported for: ${describe(unsupported.map(entry => entry.repository))}.`);
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
