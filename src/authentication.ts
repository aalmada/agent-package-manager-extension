import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Repository, RepositoryHost, repositoryForRequest, repositoryFromSource, repositoryHosts, repositoryKey, repositoryProbeUrl, validOrigin } from './auth/repositories';
import { marketplaceRepository } from './apm/remoteMetadata';
import type { Marketplace } from './apm/types';
import { parseEntry } from './config/marketplaces';

export type { Repository, RepositoryHost } from './auth/repositories';
export { repositoryForRequest, repositoryFromSource, repositoryProbeUrl } from './auth/repositories';

const scopes = ['repo'];
type Context = Pick<vscode.ExtensionContext, 'globalState' | 'secrets'>;
type Binding = { repository: Repository; account?: string; secret?: string };
export type RepositoryCredential = { repository: Repository; token: string; username: string; scheme: 'basic' | 'bearer' };
type Candidate = RepositoryCredential & { account?: string; secret?: string };
type MarketplaceSources = { settings: readonly string[]; registered: readonly Marketplace[]; workspaceRoot?: string };

function trust(): void {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using repository authentication for APM.');
}

export async function githubEnvironment(): Promise<Record<string, string>> {
  trust();
  const accounts = vscode.authentication.getAccounts ? await vscode.authentication.getAccounts('github') : undefined;
  if (accounts && accounts.length !== 1) return {};
  const session = await vscode.authentication.getSession('github', scopes, { silent: true, ...(accounts ? { account: accounts[0] } : {}) });
  return session ? { GITHUB_APM_PAT: session.accessToken } : {};
}

export async function signInToGithub(): Promise<void> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before signing in to GitHub for APM.');
  await vscode.authentication.getSession('github', scopes, { createIfNone: true });
}

class RepositoryRateLimitError extends Error {
  constructor(response: Response, authenticated: boolean) {
    const now = Date.now();
    const retryAfter = response.headers.get('retry-after');
    let retryAt = retryAfter && /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1000 :
      retryAfter ? Date.parse(retryAfter) : NaN;
    const valid = (value: number) => Number.isFinite(value) && value > now && value <= 8640000000000000;
    if (!valid(retryAt)) {
      const reset = response.headers.get('x-ratelimit-reset');
      retryAt = reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : NaN;
    }
    const retry = valid(retryAt) ? `after ${new Date(retryAt).toISOString()}` : 'after the service limit resets';
    const account = authenticated ? 'the selected account' : 'anonymous requests';
    const action = authenticated ? 'Retry' : 'Set up repository authentication with APM: Manage Repository Accounts, or retry';
    super(`Repository service rate limit reached for ${account}. ${action} ${retry}.`);
  }
}

function permission(response: Response, authenticated: boolean): boolean {
  if (response.status === 429 || (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
    throw new RepositoryRateLimitError(response, authenticated);
  }
  if (response.status >= 500) throw new Error(`Repository service unavailable (${response.status}).`);
  return [401, 403, 404].includes(response.status);
}

/** VS Code account provider for a GitHub repository; Enterprise requires `github-enterprise.uri` to match its origin exactly. */
function githubAccountProvider(repository: Repository): 'github' | 'github-enterprise' | undefined {
  if (repository.provider !== 'github') return undefined;
  if (repository.origin === 'https://github.com') return 'github';
  const configured = vscode.workspace.getConfiguration('github-enterprise').get<string>('uri');
  try { return configured && new URL(configured).origin === repository.origin ? 'github-enterprise' : undefined; } catch { return undefined; }
}

export class RepositoryAuthentication implements vscode.Disposable {
  private revision = 0;
  private disposed = false;
  private readonly namespace = `apm.authentication.${vscode.env?.remoteName ?? 'local'}.${hostname()}`;
  private readonly listener?: vscode.Disposable;
  private readonly probes = new Map<string, Promise<boolean>>();
  private readonly access = new Map<string, { at: number; allowed: boolean }>();
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;

  constructor(private readonly context: Context, private readonly marketplaceSources: () => Promise<MarketplaceSources> =
    async () => ({ settings: [], registered: [] })) {
    this.listener = context.secrets.onDidChange?.(event => {
      if (event.key.startsWith(this.namespace)) this.invalidate();
    });
  }

  get generation(): number { return this.revision; }
  invalidate(): void { this.revision++; this.probes.clear(); this.access.clear(); this.changes.fire(); }
  dispose(): void { this.disposed = true; this.invalidate(); this.listener?.dispose(); this.changes.dispose(); }
  hosts(): readonly RepositoryHost[] {
    return repositoryHosts(this.context.globalState.get<RepositoryHost[]>(`${this.namespace}.hosts`, []));
  }
  private bindings(): Binding[] {
    return this.context.globalState.get<Binding[]>(`${this.namespace}.bindings`, []).filter(binding =>
      repositoryFromSource(`${binding.repository.origin}/${binding.repository.path}`, this.hosts())?.provider === binding.repository.provider);
  }
  knownRepositories(): readonly Repository[] { return this.bindings().map(binding => ({ ...binding.repository })); }
  private check(generation: number, signal?: AbortSignal): void {
    trust();
    if (signal?.aborted || this.disposed || generation !== this.revision) throw new Error('Repository authentication cancelled or changed. Retry the operation.');
  }
  private async save(binding: Binding): Promise<void> {
    const bindings = this.bindings().filter(item => repositoryKey(item.repository) !== repositoryKey(binding.repository));
    await this.context.globalState.update(`${this.namespace}.bindings`, [...bindings, binding]);
  }
  private validate(repository: Repository): void {
    const parsed = repositoryFromSource(`${repository.origin}/${repository.path}`, this.hosts());
    if (!parsed || repositoryKey(parsed) !== repositoryKey(repository)) throw new Error('Repository authentication requires an approved repository host and path.');
  }
  private async candidates(repository: Repository, generation: number, signal?: AbortSignal): Promise<Candidate[]> {
    const binding = this.bindings().find(item => repositoryKey(item.repository) === repositoryKey(repository));
    const result: Candidate[] = [];
    if (binding?.secret) {
      const token = await this.context.secrets.get(binding.secret);
      this.check(generation, signal);
      if (token) result.push({ repository, token, username: repository.provider === 'gitlab' ? 'oauth2' : repository.provider === 'github' ? 'x-access-token' : 'apm',
        scheme: repository.provider === 'github' ? 'bearer' : 'basic', secret: binding.secret });
    }
    const provider = githubAccountProvider(repository);
    if (!provider) return result;
    const accounts = [...await vscode.authentication.getAccounts(provider)];
    this.check(generation, signal);
    accounts.sort((a, b) => Number(b.id === binding?.account) - Number(a.id === binding?.account));
    for (const account of accounts.slice(0, 20)) {
      const session = await vscode.authentication.getSession(provider, scopes, { account, silent: true });
      this.check(generation, signal);
      if (session) result.push({ repository, token: session.accessToken, username: 'x-access-token', scheme: 'bearer', account: account.id });
    }
    return result;
  }
  private authorization(candidate: RepositoryCredential): string {
    return candidate.scheme === 'bearer' ? `Bearer ${candidate.token}` :
      `Basic ${Buffer.from(`${candidate.username}:${candidate.token}`).toString('base64')}`;
  }
  private authenticationHeaders(candidate: RepositoryCredential): Record<string, string> {
    return candidate.repository.provider === 'gitlab' ? { 'PRIVATE-TOKEN': candidate.token } : { Authorization: this.authorization(candidate) };
  }
  private async probe(repository: Repository, candidate: Candidate | undefined, generation: number, signal?: AbortSignal, reuseAccess = false): Promise<boolean> {
    this.check(generation, signal);
    const identity = candidate ? createHash('sha256').update(candidate.token).digest('hex') : 'public';
    const key = `${generation}:${repositoryKey(repository)}:${identity}`;
    const cached = this.access.get(key);
    if (reuseAccess && cached && Date.now() - cached.at < 5 * 60_000) return cached.allowed;
    // CLI selection never reuses completed probes; only read-only metadata does.
    const existing = !signal && this.probes.get(key);
    if (existing) return existing;
    const operation = (async () => {
      const response = await fetch(repositoryProbeUrl(repository), {
        headers: candidate ? this.authenticationHeaders(candidate) : {},
        redirect: 'error', credentials: 'omit', signal
      });
      this.check(generation, signal);
      const denied = permission(response, candidate !== undefined);
      if (!denied && !response.ok) throw new Error(`Repository access probe failed (${response.status}).`);
      if (this.access.size >= 100) this.access.clear();
      this.access.set(key, { at: Date.now(), allowed: !denied });
      return !denied;
    })();
    if (!signal) {
      if (this.probes.size >= 100) this.probes.clear();
      this.probes.set(key, operation);
    }
    try { return await operation; } finally { if (this.probes.get(key) === operation) this.probes.delete(key); }
  }
  private async select(repository: Repository, generation: number, signal?: AbortSignal,
    options: { allowFallback?: boolean; reuseAccess?: boolean; anonymousLimit?: RepositoryRateLimitError } = {}): Promise<Candidate | undefined> {
    const bound = this.bindings().some(binding => repositoryKey(binding.repository) === repositoryKey(repository));
    let anonymousLimit = options.anonymousLimit;
    if (!bound && !anonymousLimit) {
      try {
        if (await this.probe(repository, undefined, generation, signal, options.reuseAccess)) return undefined;
      } catch (error) {
        if (!(error instanceof RepositoryRateLimitError)) throw error;
        anonymousLimit = error;
      }
    }
    const candidates = await this.candidates(repository, generation, signal);
    for (const candidate of candidates) {
      if (await this.probe(repository, candidate, generation, signal, options.reuseAccess)) {
        this.check(generation, signal);
        // A rate-limited anonymous probe cannot establish that the repository is private.
        if (!anonymousLimit) {
          await this.save({ repository, ...(candidate.account ? { account: candidate.account } : {}), ...(candidate.secret ? { secret: candidate.secret } : {}) });
          this.check(generation, signal);
        }
        return candidate;
      }
    }
    if (bound && await this.probe(repository, undefined, generation, signal, options.reuseAccess)) return undefined;
    if (anonymousLimit) throw anonymousLimit;
    if (options.allowFallback && !candidates.length && !this.bindings().some(binding => repositoryKey(binding.repository) === repositoryKey(repository))) return undefined;
    throw new Error(`No authorized account can access ${repository.origin}/${repository.path}. Use APM: Manage Repository Accounts to select an account or update its token.`);
  }
  async credentials(repositories: readonly Repository[], signal?: AbortSignal): Promise<readonly RepositoryCredential[]> {
    const generation = this.revision;
    this.check(generation, signal);
    const result: RepositoryCredential[] = [];
    const unique = [...new Map(repositories.map(repository => [repositoryKey(repository), repository])).values()];
    if (unique.length > 100) throw new Error('Too many repositories in one authentication request.');
    for (const repository of unique) {
      this.validate(repository);
      const candidate = await this.select(repository, generation, signal, { allowFallback: true });
      this.check(generation, signal);
      if (candidate) result.push({ repository, token: candidate.token, username: candidate.username, scheme: candidate.scheme });
    }
    return result;
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const text = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/%2e|%5c|\/\.\.?(?:\/|$)/i.test(text)) throw new Error('APM metadata requests require an approved repository URL.');
    const url = new URL(text);
    const repository = repositoryForRequest(url, this.hosts());
    if (!repository || !['GET', 'HEAD'].includes((init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase())) {
      throw new Error('APM metadata requests require an approved repository HTTPS URL and a read-only method.');
    }
    const generation = this.revision;
    const signal = init?.signal ?? (typeof input === 'object' && 'signal' in input ? input.signal : undefined) ?? undefined;
    this.check(generation, signal);
    const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
    headers.delete('Authorization'); headers.delete('Cookie'); headers.delete('Proxy-Authorization'); headers.delete('PRIVATE-TOKEN');
    const options = { ...init, headers, redirect: 'error' as const, credentials: 'omit' as const, signal };
    const bound = this.bindings().some(binding => repositoryKey(binding.repository) === repositoryKey(repository));
    let candidate = bound ? await this.select(repository, generation, signal, { reuseAccess: true }) : undefined;
    if (candidate) for (const [name, value] of Object.entries(this.authenticationHeaders(candidate))) headers.set(name, value);
    const response = await fetch(url.href, options);
    this.check(generation, signal);
    let anonymousLimit: RepositoryRateLimitError | undefined;
    try {
      if (!permission(response, candidate !== undefined)) return response;
    } catch (error) {
      if (!(error instanceof RepositoryRateLimitError) || candidate || bound) throw error;
      anonymousLimit = error;
    }
    // An authorized repository can legitimately have missing optional files.
    if (candidate && response.status === 404) return response;
    if (candidate) {
      this.access.clear();
      throw new Error(`Repository access denied (${response.status}). Use APM: Manage Repository Accounts to update its authentication.`);
    }
    candidate = await this.select(repository, generation, signal, { reuseAccess: true, anonymousLimit });
    this.check(generation, signal);
    if (!candidate) return response;
    for (const [name, value] of Object.entries(this.authenticationHeaders(candidate))) headers.set(name, value);
    const authenticated = await fetch(url.href, options);
    this.check(generation, signal);
    permission(authenticated, true);
    return authenticated;
  };
  private async chooseRepository(): Promise<Repository | undefined> {
    const sources = await this.marketplaceSources();
    trust();
    const hosts = this.hosts();
    const repositories = new Map<string, Repository>();
    const add = (repository: Repository | undefined) => {
      if (!repository) return;
      const key = repositoryKey(repository);
      repositories.set(repository.provider === 'github' ? key.toLowerCase() : key, repository);
    };
    for (const repository of this.knownRepositories()) add(repository);
    for (const marketplace of sources.registered) {
      if (!/\.json(?:\?.*)?$/i.test(marketplace.source)) add(marketplaceRepository(marketplace, hosts));
    }
    let invalid = false;
    for (const text of sources.settings) {
      try {
        const entry = parseEntry(text, sources.workspaceRoot);
        if (!entry.local && !/\.json(?:\?.*)?$/i.test(entry.source)) add(repositoryFromSource(entry.source, hosts));
      } catch {
        invalid = true;
      }
    }
    if (invalid) void vscode.window.showWarningMessage('Some marketplace settings could not be used for repository selection. Review APM marketplace settings.');
    const choices = [...repositories.values()].map(repository => ({
      label: `${repository.origin}/${repository.path}`, repository
    }));
    const choice = await vscode.window.showQuickPick([
      ...choices, { label: 'Enter another repository...', repository: undefined }
    ], { title: 'Select a repository', placeHolder: 'Choose a marketplace or known repository' });
    if (!choice) return undefined;
    trust();
    if (choice.repository) return choice.repository;
    const source = await vscode.window.showInputBox({ prompt: 'Repository URL or GitHub owner/repository', ignoreFocusOut: true });
    if (!source) return undefined;
    const repository = repositoryFromSource(source, this.hosts());
    if (!repository) throw new Error('Enter a repository URL on a known or explicitly approved host.');
    return repository;
  }
  async manage(): Promise<void> {
    trust();
    const action = await vscode.window.showQuickPick([
      'Connect GitHub account', 'Add repository token', 'Approve repository host', 'Remove repository authentication'
    ], { title: 'APM Repository Authentication' });
    if (!action) return;
    if (action === 'Approve repository host') {
      const origin = await vscode.window.showInputBox({ prompt: 'Repository host HTTPS origin (no path)', ignoreFocusOut: true });
      if (!origin) return;
      if (!validOrigin(origin)) throw new Error('Enter an HTTPS origin without credentials or a path.');
      const provider = await vscode.window.showQuickPick(['github', 'gitlab', 'azure'] as const, { title: 'Repository host provider' });
      if (!provider) return;
      trust();
      await this.context.globalState.update(`${this.namespace}.hosts`, [...this.hosts().filter(host => host.origin !== origin), { origin, provider }]);
      this.invalidate(); return;
    }
    if (action === 'Remove repository authentication') {
      const binding = await vscode.window.showQuickPick(this.bindings().map(item => ({ label: `${item.repository.origin}/${item.repository.path}`, binding: item })),
        { title: 'Disconnect repository (does not sign out of VS Code Accounts)' });
      if (!binding) return;
      trust();
      if (binding.binding.secret) await this.context.secrets.delete(binding.binding.secret);
      await this.context.globalState.update(`${this.namespace}.bindings`, this.bindings().filter(item => repositoryKey(item.repository) !== repositoryKey(binding.binding.repository)));
      this.invalidate(); return;
    }
    const repository = await this.chooseRepository();
    if (!repository) return;
    trust();
    this.validate(repository);
    if (action === 'Connect GitHub account') {
      if (repository.provider !== 'github') throw new Error('Use a repository token for GitLab or Azure DevOps.');
      const provider = githubAccountProvider(repository);
      if (!provider) throw new Error('Configure github-enterprise.uri for this exact host first.');
      const session = await vscode.authentication.getSession(provider, scopes, { createIfNone: true, clearSessionPreference: true });
      const generation = this.revision;
      this.check(generation);
      if (!session) throw new Error('GitHub account authorization was not completed.');
      const candidate: Candidate = { repository, token: session.accessToken, username: 'x-access-token', scheme: 'bearer', account: session.account.id };
      if (!await this.probe(repository, candidate, generation)) throw new Error('This account cannot access the selected repository.');
      await this.save({ repository, account: session.account.id });
    } else {
      const token = await vscode.window.showInputBox({ prompt: 'Repository-scoped personal access token (stored only in VS Code SecretStorage)', password: true, ignoreFocusOut: true });
      if (!token) return;
      const generation = this.revision;
      this.check(generation);
      const candidate: Candidate = { repository, token, username: repository.provider === 'gitlab' ? 'oauth2' : 'apm', scheme: repository.provider === 'github' ? 'bearer' : 'basic' };
      if (!await this.probe(repository, candidate, generation)) throw new Error('This token cannot access the selected repository.');
      const secret = `${this.namespace}.token.${randomUUID()}`;
      const old = this.bindings().find(item => repositoryKey(item.repository) === repositoryKey(repository));
      await this.context.secrets.store(secret, token);
      await this.save({ repository, secret });
      if (old?.secret) await this.context.secrets.delete(old.secret);
    }
    this.invalidate();
    await vscode.window.showInformationMessage('Repository authentication saved. Credentials are never shared with the webview.');
  }
}

// Compatibility adapter: callers that persist authentication should supply their
// RepositoryAuthentication instance instead of this non-persistent wrapper.
export const githubFetch: typeof fetch = (input, init) => {
  const auth = new RepositoryAuthentication({
    globalState: { get: (_key: string, fallback?: unknown) => fallback, update: async () => {}, keys: () => [], setKeysForSync: () => {} } as vscode.Memento & { setKeysForSync(keys: readonly string[]): void },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } as unknown as vscode.SecretStorage
  });
  return auth.fetch(input, init).finally(() => auth.dispose());
};
