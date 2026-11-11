import * as vscode from 'vscode';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { ApmClient } from './apm/client';
import { record, type VariablePrompt } from './apm/adapters';
import { descriptors, buildCommandArguments, requiresTerminal } from './apm/commands';
import type { Marketplace, PackageItem, Scope } from './apm/types';
import type { Message, Mode, PackageSection, State } from './protocol';
import { inScope, isSameScope, parseMessage, scopeKey, scopeLabel } from './protocol';
import { SettingsSync } from './config/sync';
import { webviewHtml } from './views/html';
import { filterTokens, withStatus, withToken, type Ordering } from './webview/filter';
import { renderMarkdown } from './views/markdown';
import { containsUrlCredentials, redact, safePayload } from './apm/redact';
import { detectInstallation, selfUpdateCommand, type InstallMethod } from './apm/installation';
import { packageIdentity, packageUpdateCommand, parseAudit, parseTargets, parseVersions, tail, verifyPackageUpdate, versionSource, withRef, type ActionResult, type PackageAction } from './apm/actions';
import { applyUpdateRows, findInstalledPackage, getUpdateBadge, reconcileDetailContexts, retainUpdateResults, withInstallations } from './apm/packageState';
import { resolvedTargets, workflowCommands, recoveryActions, type Workflow, type CommandRequest } from './apm/workflows';
import { AuditDiagnostics, contentNavigation, openNavigation, type NavigationTarget, type AuditTicket } from './navigation';
import { registerManifestAssistance } from './manifestAssistance';
import { registerApmTaskProvider } from './taskProvider';
import type { ContentGroup } from './apm/contents';
import { hasProjectManifest, projectManifestPath, readProjectManifest, resolveContained } from './apm/manifest';
import { RepositoryAccessError, RepositoryAuthentication, signInToGithub } from './authentication';
import { cliEnvironment } from './auth/cli';
import { repositoryFromPackageSource, type Repository } from './auth/repositories';
import { parseDependencyTree } from './apm/dependencyTree';

interface PanelContext {
  webview?: vscode.Webview;
  mode: Mode | 'native';
  panel?: vscode.WebviewPanel;
  scope?: Scope;
  item?: PackageItem;
  controller?: AbortController;
  detailsController?: AbortController;
  detailsRequest?: number;
  refreshError?: string;
  extra: Partial<State>;
  navigation?: Map<string, NavigationTarget>;
  retry?: () => Promise<void>;
  authenticationRepository?: Repository;
  preview?: { id: string; args: Record<string, string>; options: Record<string, unknown>; title: string; action: PackageAction };
}

const remoteRefreshInterval = 5 * 60_000;

class ApmExtension implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('APM');
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly panels = new Map<string, PanelContext>();
  private sidebar?: PanelContext;
  private sidebarView?: vscode.WebviewView;
  private search = '';
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly catalogSnapshots = new Map<string, { at: number; items: PackageItem[]; errors: string[] }>();
  private readonly updateSnapshots = new Map<string, { at: number; items: PackageItem[]; checkedAt?: string; error?: string }>();
  private operation?: AbortController;
  private refreshController?: AbortController;
  private queues = new Map<string, Promise<void>>();
  private readonly commandTasks = new Map<PanelContext, { execution?: vscode.TaskExecution; cancelled: boolean }>();
  private readonly nativeOperations = new Set<PanelContext>();
  private readonly results = new Map<string, string>();
  private resultId = 0;
  private refreshNotices = new Set<string>();
  private readonly readmeNotices = new Set<string>();
  private epoch = 0;
  private readonly settingsSync: SettingsSync;
  private readonly diagnostics = new AuditDiagnostics();
  private readonly authentication: RepositoryAuthentication;
  private state: State = {
    mode: 'browser', trusted: vscode.workspace.isTrusted, scopes: [], scopeKey: '', busy: false,
    catalog: [], installed: [], marketplaces: [], commands: descriptors, availableCommands: [], errors: []
  };
  constructor(private readonly context: vscode.ExtensionContext) {
    this.authentication = new RepositoryAuthentication(context, async () => {
      const settings = vscode.workspace.getConfiguration('apm').get<unknown>('marketplaces', []);
      if (!Array.isArray(settings) || !settings.every(entry => typeof entry === 'string')) {
        throw new Error('APM Marketplaces must be a list of strings.');
      }
      const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
      return { settings, registered: await this.client(this.globalScope()).getMarketplaces(),
        workspaceRoot: folders.length === 1 ? folders[0].uri.fsPath : undefined };
    });
    this.subscriptions.push(this.authentication);
    this.search = context.workspaceState.get<string>('browserSearch', '');
    this.state.hiddenSections = context.workspaceState.get<PackageSection[]>('hiddenSections', []);
    this.rebuildScopes();
    this.settingsSync = new SettingsSync(
      context.globalState, () => this.client(this.globalScope()), text => this.output.append(redact(text)),
      message => this.report(new Error(message)), operation => this.serialize('apm-mutations', operation)
    );
    this.subscriptions.push(this.output, this.diagnostics);
    this.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('apm-result', {
      provideTextDocumentContent: uri => {
        const content = this.results.get(uri.toString());
        if (content === undefined) throw new Error('This APM result has expired. Run the action again.');
        return content;
      }
    }), vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme === 'apm-result') this.results.delete(document.uri.toString());
    }));
    this.subscriptions.push(registerManifestAssistance({
      details: (dependency, uri) => this.findDependency(dependency, uri)
    }));
    this.subscriptions.push(registerApmTaskProvider(message => this.report(new Error(message)), operation => this.serialize('apm-mutations', operation),
      (args, cwd, signal) => this.commandEnvironment(args, cwd, signal)));
    this.subscriptions.push(this.authentication.onDidChange(() => this.authenticationChanged()));
    this.subscriptions.push(vscode.authentication.onDidChangeSessions(event => {
      if (event.provider.id === 'github' || event.provider.id === 'github-enterprise') this.authentication.invalidate();
    }));
    this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { this.rebuildScopes(); this.scheduleRefresh(); }));
    this.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.settingsSync.sync(); this.scheduleRefresh(); }));
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('github-enterprise.uri')) this.authentication.invalidate();
      if (event.affectsConfiguration('apm.executablePath')) { this.epoch++; this.state.version = undefined; this.clearRemoteSnapshots(); this.scheduleRefresh(); }
      if (event.affectsConfiguration('apm.allowRemoteImages')) {
        for (const entry of this.panels.values()) {
          if (entry.mode !== 'details') continue;
          if (typeof entry.extra.details?.readme === 'string') this.setReadme(entry, entry.extra.details.readme);
          if (entry.webview) entry.webview.html = webviewHtml(entry.webview, this.context.extensionUri, this.allowRemoteImages());
        }
      }
      if (event.affectsConfiguration('apm.marketplaces')) {
        this.settingsSync.retry(vscode.workspace.getConfiguration('apm').get<string[]>('marketplaces', []).map(text => String(text).trim()));
        void this.settingsSync.sync().then(() => this.scheduleRefresh());
      } else if (event.affectsConfiguration('apm.config')) void this.settingsSync.sync();
    }));
    for (const pattern of ['**/apm.yml', '**/apm.lock.yaml', '**/apm.lock']) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      this.subscriptions.push(watcher, watcher.onDidChange(() => this.scheduleRefresh()), watcher.onDidCreate(() => this.scheduleRefresh()), watcher.onDidDelete(() => this.scheduleRefresh()));
    }
    const globalPackages = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(join(homedir(), '.apm')), '{apm.yml,apm.lock.yaml,apm.lock}'));
    this.subscriptions.push(globalPackages, globalPackages.onDidChange(() => this.scheduleRefresh()),
      globalPackages.onDidCreate(() => this.scheduleRefresh()), globalPackages.onDidDelete(() => this.scheduleRefresh()));
    const registry = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(join(homedir(), '.apm')), 'marketplaces.json'));
    const syncRegistry = () => { void this.settingsSync.sync().then(() => this.scheduleRefresh()); };
    this.subscriptions.push(registry, registry.onDidChange(syncRegistry), registry.onDidCreate(syncRegistry), registry.onDidDelete(syncRegistry));
    const cliConfig = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(join(homedir(), '.apm')), 'config.json'));
    const syncConfig = () => void this.settingsSync.sync();
    this.subscriptions.push(cliConfig, cliConfig.onDidChange(syncConfig), cliConfig.onDidCreate(syncConfig), cliConfig.onDidDelete(syncConfig));
    void this.settingsSync.sync();
    this.updateFilterContext();
  }
  dispose() {
    this.operation?.abort();
    this.refreshController?.abort();
    for (const task of this.commandTasks.values()) { task.cancelled = true; task.execution?.terminate(); }
    this.commandTasks.clear();
    for (const context of this.nativeOperations) context.controller?.abort();
    this.nativeOperations.clear(); this.results.clear();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const disposable of this.subscriptions) disposable.dispose();
    for (const entry of this.panels.values()) { entry.controller?.abort(); entry.detailsController?.abort(); entry.panel?.dispose(); }
  }
  private rebuildScopes() {
    const previous = this.state.scopeKey || this.context.workspaceState.get<string>('scopeKey');
    this.state.scopes = [
      ...(vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => ({ kind: 'workspace' as const, path: f.uri.fsPath, label: f.name })),
      { kind: 'global', path: join(homedir(), '.apm'), label: 'Global (user)' }
    ];
    this.state.scopeKey = this.state.scopes.some(s => scopeKey(s) === previous) ? previous! : scopeKey(this.state.scopes[0]);
  }
  private globalScope(): Scope { return this.state.scopes.find(s => s.kind === 'global')!; }
  private scope(context?: PanelContext): Scope {
    return context?.scope ?? this.state.scopes.find(s => scopeKey(s) === this.state.scopeKey)!;
  }
  private client(scope = this.scope(), signal?: AbortSignal) {
    const resource = scope.kind === 'workspace' ? vscode.Uri.file(scope.path) : undefined;
    return new ApmClient({
      executable: vscode.workspace.getConfiguration('apm', resource).get<string>('executablePath', 'apm'),
      cwd: scope.kind === 'global' ? homedir() : scope.path,
      signal,
      environment: (args, cwd, cancellation) => this.commandEnvironment(args, cwd, cancellation),
      fetcher: (input, init) => this.authentication.fetch(input, { ...init,
        signal: signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal }),
      repositoryHosts: () => this.authentication.hosts(),
      onOutput: text => this.output.append(redact(text))
    });
  }
  private requireTrust() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running APM or reading package sources.');
  }
  private commandEnvironment(args: readonly string[], cwd: string, signal?: AbortSignal) {
    this.requireTrust();
    const generation = this.authentication.generation;
    return cliEnvironment(this.authentication, args, cwd, homedir(), signal).then(environment => {
      this.requireTrust();
      signal?.throwIfAborted();
      if (generation !== this.authentication.generation) throw new Error('Repository authentication changed. Run the operation again.');
      return environment;
    });
  }
  private authenticationChanged() {
    this.epoch++;
    this.clearRemoteSnapshots();
    this.refreshController?.abort();
    for (const entry of this.panels.values()) {
      if (entry.mode !== 'details') continue;
      entry.detailsController?.abort();
      entry.detailsRequest = (entry.detailsRequest ?? 0) + 1;
      entry.extra = { ...entry.extra, details: undefined, readmeHtml: undefined, busy: false };
      this.send(entry);
    }
    this.settingsSync.retry();
    this.scheduleRefresh();
  }
  private allowRemoteImages() {
    return vscode.workspace.getConfiguration('apm').get<boolean>('allowRemoteImages', false);
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.sidebarView = view;
    this.sidebar = this.attach(view.webview, 'browser');
    this.updateBadge();
    this.subscriptions.push(
      view.onDidChangeVisibility(() => { if (view.visible) void this.refresh(); }),
      view.onDidDispose(() => {
        if (this.sidebarView === view) { this.sidebarView = undefined; this.sidebar = undefined; }
      })
    );
  }
  private attach(webview: vscode.Webview, mode: Mode, panel?: vscode.WebviewPanel): PanelContext {
    const context: PanelContext = { webview, mode, panel, extra: {} };
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    webview.html = webviewHtml(webview, this.context.extensionUri, mode === 'details' && this.allowRemoteImages());
    this.subscriptions.push(webview.onDidReceiveMessage((raw: unknown) => {
      void Promise.resolve().then(() => this.handle(parseMessage(raw), context)).catch(error => this.report(error, context));
    }));
    return context;
  }
  private send(context: PanelContext) {
    if (!context.webview || context.mode === 'native') return;
    const state: State = {
      ...this.state, ...context.extra, mode: context.mode, trusted: vscode.workspace.isTrusted,
      host: this.hostLabel(),
      browserSearch: this.search,
      errors: context.refreshError ? [...this.state.errors, context.refreshError] : this.state.errors,
      ...(context.scope ? { scopeKey: scopeKey(context.scope) } : {}), ...(context.item ? { item: context.item } : {})
    };
    void context.webview?.postMessage({ type: 'state', state: safePayload(state) });
  }
  private broadcast() {
    this.updateBadge();
    if (this.sidebar) this.send(this.sidebar);
    for (const panel of this.panels.values()) this.send(panel);
  }
  private updateBadge() {
    if (this.sidebarView) this.sidebarView.badge = getUpdateBadge({ ...this.state, trusted: vscode.workspace.isTrusted });
  }
  report(error: unknown, context?: PanelContext) {
    const message = redact(error instanceof Error ? error.message : String(error));
    this.output.appendLine(`\nERROR: ${message}`);
    if (context) { context.extra.error = message; this.send(context); } else { this.state.error = message; this.broadcast(); }
    this.notifyError(message, context);
  }
  private notifyError(message: string, context?: PanelContext) {
    const labels = recoveryActions(message).map(action => ({ output: 'Show APM Output', doctor: 'Run Doctor', authentication: 'Authentication Help', policy: 'Explain Policy', targets: 'Show Targets', retry: 'Retry' })[action]);
    if (context?.retry && !labels.includes('Retry')) labels.push('Retry');
    if (labels.includes('Authentication Help')) labels.unshift('Manage Repository Accounts', 'Sign in to GitHub');
    const item = context?.item;
    const source = labels.includes('Authentication Help') && item && !item.marketplace ? packageIdentity(item, item.installed ? item : undefined, true) : undefined;
    const repository = context?.authenticationRepository ?? (source ? repositoryFromPackageSource(source, this.authentication.hosts()) : undefined);
    const scope = context?.scope;
    void vscode.window.showErrorMessage(message, ...labels).then(choice => {
      if (choice === 'Show APM Output') this.output.show();
      else if (choice === 'Run Doctor') void this.workflow('doctor', undefined, context?.scope).catch(error => this.report(error, context));
      else if (choice === 'Explain Policy') void this.workflow('policy', undefined, context?.scope).catch(error => this.report(error, context));
      else if (choice === 'Show Targets') void this.showTargets(context).catch(error => this.report(error, context));
      else if (choice === 'Authentication Help') void vscode.env.openExternal(vscode.Uri.parse('https://microsoft.github.io/apm/getting-started/authentication/'));
      else if (choice === 'Sign in to GitHub') void this.signIn().catch(error => this.report(error, context));
      else if (choice === 'Manage Repository Accounts') void this.manageAccounts(repository, scope).catch(error => this.report(error, context));
      else if (choice === 'Retry' && context?.retry) void context.retry().catch(error => this.report(error, context));
    });
  }
  async signIn() {
    await signInToGithub();
    this.authentication.invalidate();
    await this.refreshAll();
  }
  async manageAccounts(repository?: Repository, scope = this.scope()) {
    this.requireTrust();
    await this.authentication.manage(repository, scope.path);
    await this.refreshAll();
  }
  private notifyRefresh() {
    const notices = new Set<string>();
    for (const message of this.state.errors) {
      const key = `${this.state.scopeKey}:error:${message}`;
      notices.add(key);
      if (!this.refreshNotices.has(key)) {
        this.output.appendLine(`\nERROR: ${message}`);
        this.notifyError(message);
      }
    }
    if (this.state.warning) {
      const message = this.state.warning, key = `${this.state.scopeKey}:warning:${message}`;
      notices.add(key);
      if (!this.refreshNotices.has(key)) {
        void vscode.window.showWarningMessage(message, 'Update APM', 'Show APM Output').then(choice => {
          if (choice === 'Update APM') void this.setup().catch(error => this.report(error));
          else if (choice === 'Show APM Output') this.output.show();
        });
      }
    }
    this.refreshNotices = notices;
  }
  private scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.refreshing) this.refreshAgain = true;
      else if (this.queues.has('apm-mutations') || this.commandTasks.size) this.scheduleRefresh();
      else void this.refresh();
    }, 400);
  }
  private clearRemoteSnapshots() {
    this.catalogSnapshots.clear();
    this.updateSnapshots.clear();
  }
  private async refreshCatalog(client: ApmClient, marketplaces: Marketplace[]) {
    const items: PackageItem[] = [], errors: string[] = [], keys = new Set<string>();
    for (const marketplace of marketplaces) {
      const key = JSON.stringify([marketplace.name, marketplace.source, marketplace.ref, marketplace.path]);
      keys.add(key);
      let snapshot = this.catalogSnapshots.get(key);
      const local = isAbsolute(marketplace.source) || marketplace.source.startsWith('file://');
      if (!snapshot || local || Date.now() - snapshot.at >= remoteRefreshInterval) {
        const at = Date.now(), epoch = this.epoch;
        const result = await client.getCatalog([marketplace]);
        snapshot = { at, ...result };
        if (epoch === this.epoch) this.catalogSnapshots.set(key, snapshot);
      }
      items.push(...snapshot.items); errors.push(...snapshot.errors);
    }
    for (const key of this.catalogSnapshots.keys()) if (!keys.has(key)) this.catalogSnapshots.delete(key);
    return { items, errors };
  }
  private async refreshUpdates(client: ApmClient, scope: Scope, installed: PackageItem[], previous: PackageItem[]) {
    const key = scopeKey(scope), snapshot = this.updateSnapshots.get(key);
    if (snapshot && Date.now() - snapshot.at < remoteRefreshInterval) {
      return { ...snapshot, items: retainUpdateResults(installed, snapshot.items, false) };
    }
    const at = Date.now(), epoch = this.epoch;
    let result: { at: number; items: PackageItem[]; checkedAt?: string; error?: string };
    try {
      const updates = await client.checkUpdates(scope, installed);
      result = { at, items: applyUpdateRows(installed, updates), checkedAt: new Date().toISOString() };
    } catch (error) {
      result = { at, items: retainUpdateResults(installed, snapshot?.items ?? previous), checkedAt: snapshot?.checkedAt,
        error: redact(String(error)) };
    }
    if (epoch === this.epoch) this.updateSnapshots.set(key, result);
    return result;
  }
  /** Explicit user refresh: also retries marketplace entries that previously failed to register. */
  async refreshAll() {
    this.settingsSync.retry();
    if (this.refreshing) await this.refreshing;
    this.clearRemoteSnapshots();
    const requests = new Map([...this.panels.values()].filter(entry => entry.mode === 'details').map(entry => [entry, entry.detailsRequest]));
    await this.refresh();
    if (this.state.error) return;
    await Promise.all([...requests].filter(([entry, request]) => entry.detailsRequest === request && entry.item && entry.panel)
      .map(([entry]) => this.loadDetails(entry)));
  }
  async refresh(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    if (this.refreshing) return this.refreshing;
    this.refreshAgain = false;
    this.refreshing = Promise.resolve(vscode.window.withProgress({ location: { viewId: 'apm.browser' } }, () => this.doRefresh())).catch(error => this.report(error)).finally(() => {
      this.refreshing = undefined;
      if (this.refreshAgain) { this.refreshAgain = false; this.scheduleRefresh(); }
    });
    return this.refreshing;
  }
  private async doRefresh() {
    if (!vscode.workspace.isTrusted) { this.broadcast(); return; }
    const epoch = this.epoch;
    const controller = new AbortController();
    this.refreshController = controller;
    const scope = this.scope(), client = this.client(scope, controller.signal);
    const workspace = scope.kind === 'workspace' ? scope : this.state.scopes.find(candidate => candidate.kind === 'workspace');
    const scopes = [this.globalScope(), ...(workspace ? [workspace] : [])];
    const previousInstalled = this.state.installed;
    this.state.busy = true; this.state.error = undefined; this.state.errors = []; this.broadcast();
    try {
      const probe = await client.probe();
      if (epoch !== this.epoch) return;
      this.state.version = probe.version; this.state.warning = probe.warning; this.state.availableCommands = probe.commands;
      this.state.projectPresent = !!workspace && await hasProjectManifest(workspace.path);
      await this.settingsSync.sync();
      if (epoch !== this.epoch) return;
      const { registered, catalog, installed } = await this.serialize('apm-mutations', async () => {
        const registered = await client.getMarketplaces();
        const [catalog, installed] = await Promise.all([
          Promise.allSettled([this.refreshCatalog(client, registered)]).then(([result]) => result),
          Promise.all(scopes.map(async target => ({
            scope: target,
            result: await Promise.allSettled([target.kind === 'workspace' && !this.state.projectPresent
              ? Promise.resolve([] as PackageItem[]) : this.client(target, controller.signal).getInstalled(target)]).then(([result]) => result)
          })))
        ]);
        return { registered, catalog, installed };
      });
      if (epoch !== this.epoch) return;
      this.state.marketplaces = registered;
      if (catalog.status === 'fulfilled') {
        const failed = registered.filter(m => !catalog.value.items.some(i => i.marketplace === m.name) && catalog.value.errors.some(error => error.startsWith(`${m.name}:`))).map(m => m.name);
        this.state.catalog = [...catalog.value.items, ...this.state.catalog.filter(i => failed.includes(i.marketplace)).map(i => ({ ...i, metadata: { ...i.metadata, stale: true } }))];
        this.state.errors.push(...catalog.value.errors);
      } else this.state.errors.push(`Catalog: ${redact(String(catalog.reason))}`);
      // `apm deps list` has no descriptions; borrow catalog ones so text filters match Installed and Updates too.
      this.state.installed = installed.flatMap<PackageItem>(({ scope: target, result }) => {
        if (result.status === 'fulfilled') {
          this.setDetailRefreshError(target);
          return this.withDescriptions(result.value).map(item => ({ ...item, scope: target }));
        }
        const error = `Installed: ${target.label}: ${redact(String(result.reason))}`;
        this.state.errors.push(error);
        this.setDetailRefreshError(target, error, false);
        return previousInstalled.filter(item => inScope(item, target))
          .map(item => ({ ...item, updateStale: true }));
      });
      this.state.checkedAt = undefined;
      for (const { scope: target, result } of installed) {
        if (result.status === 'fulfilled') this.updateDetailItems(target, this.state.installed.filter(item => inScope(item, target)));
      }
      this.broadcast();
      for (const { scope: target, result } of installed) {
        if (result.status !== 'fulfilled' || !result.value.length) continue;
        const items = this.state.installed.filter(item => inScope(item, target));
        const updates = await this.refreshUpdates(this.client(target, controller.signal), target, items, previousInstalled);
        if (epoch !== this.epoch) return;
        this.state.installed = this.state.installed.map(item => inScope(item, target)
          ? findInstalledPackage(item, updates.items) ?? item : item);
        this.state.checkedAt = updates.checkedAt;
        if (updates.error) {
          const error = `Updates: ${target.label}: ${updates.error}`;
          this.state.errors.push(error);
          this.setDetailRefreshError(target, error, false);
        }
      }
      this.state.catalog = withInstallations(this.state.catalog, this.state.installed);
      for (const { scope: target, result } of installed) {
        if (result.status === 'fulfilled') this.updateDetailItems(target, this.state.installed.filter(item => inScope(item, target)));
      }
      await this.refreshOtherDetailScopes(scopes, controller.signal, epoch);
      if (epoch === this.epoch) await Promise.all([...this.panels.values()]
        .filter(entry => entry.mode === 'details' && entry.item && entry.panel && !entry.extra.details && !entry.extra.busy)
        .map(entry => this.loadDetails(entry)));
    } catch (error) {
      if (epoch === this.epoch) throw error;
    } finally {
      this.refreshController = undefined; this.state.busy = false; this.broadcast();
      if (epoch === this.epoch) this.notifyRefresh();
    }
  }
  private withDescriptions(items: PackageItem[]): PackageItem[] {
    return items.map(item => item.description ? item : { ...item, description: this.state.catalog.find(c => c.id === item.id)?.description });
  }
  private detailContexts(scope: Scope): PanelContext[] {
    return [...this.panels.values()].filter(entry => entry.mode === 'details' && inScope(entry, scope) && entry.item);
  }
  private setDetailRefreshError(scope: Scope, error?: string, notify = true) {
    const entries = this.detailContexts(scope);
    if (notify && error && entries.some(entry => entry.refreshError !== error)) {
      this.output.appendLine(`\n${error}`);
      this.notifyError(error, entries[0]);
    }
    for (const entry of entries) entry.refreshError = error;
  }
  private updateDetailItems(scope: Scope, installed: PackageItem[]) {
    reconcileDetailContexts(this.panels.values(), scope, this.state.catalog, installed, entry => { void this.loadDetails(entry); });
    for (const entry of this.detailContexts(scope)) this.send(entry);
  }
  private async refreshOtherDetailScopes(selected: readonly Scope[], signal: AbortSignal, epoch: number) {
    const scopes = new Map<string, Scope>();
    for (const entry of this.panels.values()) {
      if (entry.mode === 'details' && entry.scope && entry.item && !selected.some(scope => isSameScope(entry.scope!, scope))) {
        scopes.set(scopeKey(entry.scope), entry.scope);
      }
    }
    await Promise.all([...scopes.values()].map(async scope => {
      const previous = this.detailContexts(scope).flatMap(entry => entry.item ? [entry.item] : []);
      const client = this.client(scope, signal);
      try {
        let installed: PackageItem[] = this.withDescriptions(await client.getInstalled(scope)).map(item => ({ ...item, scope }));
        if (epoch !== this.epoch || signal.aborted) return;
        this.setDetailRefreshError(scope);
        this.updateDetailItems(scope, installed);
        let warning: string | undefined;
        if (installed.length) {
          const updates = await this.refreshUpdates(client, scope, installed, previous);
          if (epoch !== this.epoch || signal.aborted) return;
          installed = updates.items;
          if (updates.error) warning = `Updates (${scope.label}): ${updates.error}`;
        }
        this.setDetailRefreshError(scope, warning);
        this.updateDetailItems(scope, installed);
      } catch (error) {
        if (epoch !== this.epoch || signal.aborted) return;
        this.setDetailRefreshError(scope, `Installed (${scope.label}): ${redact(String(error))}`);
      }
    }));
  }
  private hostLabel() { return vscode.env.remoteName ? `Remote: ${vscode.env.remoteName}` : 'Local'; }
  showOutput() { this.output.show(); }
  async chooseAnyScope() {
    const picked = await vscode.window.showQuickPick(this.state.scopes.map(scope => ({
      label: scope.kind === 'global' ? '$(globe) Global (user)' : `$(folder) ${scope.label}`,
      description: scope.path, detail: `${this.hostLabel()}${scopeKey(scope) === this.state.scopeKey ? ' — Current scope' : ''}`, scope
    })), { title: 'APM package scope', placeHolder: 'Choose where packages are installed' });
    if (picked) await this.selectScope(scopeKey(picked.scope));
  }
  private async workflowScope(uri?: vscode.Uri, capturedScope?: Scope, projectOnly = false): Promise<Scope | undefined> {
    this.requireTrust();
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    const scope = capturedScope ?? (folder ? { kind: 'workspace' as const, label: folder.name, path: folder.uri.fsPath } : { ...this.scope() });
    if (!projectOnly || scope.kind === 'workspace') return scope;
    const folders = this.state.scopes.filter(scope => scope.kind === 'workspace');
    if (!folders.length) throw new Error('Open a workspace folder to use this APM action.');
    const picked = await vscode.window.showQuickPick(folders.map(scope => ({ label: scope.label, description: scope.path, scope })),
      { title: 'Choose APM project', placeHolder: 'Select the project for this action' });
    return picked?.scope;
  }
  async workflow(workflow: Workflow, uri?: vscode.Uri, capturedScope?: Scope) {
    const scope = await this.workflowScope(uri, capturedScope, workflow !== 'previewInstall' && workflow !== 'doctor' && workflow !== 'policy');
    if (!scope) return;
    if (workflow === 'previewInstall') { await this.installPackage(scope, true); return; }
    if (workflow === 'runScript') { await this.runProjectScript(scope); return; }
    const command = workflowCommands[workflow];
    const args: Record<string, string> = {}, options: Record<string, unknown> = { ...command.options };
    if (workflow === 'policy') {
      const installed = await this.client(scope).getInstalled(scope);
      if (!installed.length) throw new Error('Install a package before inspecting its policy.');
      const picked = await vscode.window.showQuickPick(installed.map(item => ({ label: item.name, description: item.version, item })),
        { title: `Explain package policy — ${scope.label}`, placeHolder: 'Select an installed dependency' });
      if (!picked) return;
      const packageName = packageIdentity(picked.item, picked.item, false);
      if (!packageName || packageName.startsWith('-') || /[\s\0]/.test(packageName)) {
        throw new Error('APM returned an invalid dependency identity.');
      }
      await this.showPolicyReport(scope, `Executable trust policy: ${packageName}`, ['policy', 'explain', packageName]);
      return;
    }
    let inputLines: string[] | undefined;
    if (workflow === 'initialize') {
      if (await hasProjectManifest(scope.path)) {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(projectManifestPath(scope.path))));
        return;
      }
      const name = await vscode.window.showInputBox({ title: 'Initialize APM project (1/5)', prompt: 'Project name', value: scope.label, ignoreFocusOut: true,
        validateInput: value => /^[a-zA-Z0-9][\w.-]*$/.test(value) ? undefined : 'Use letters, numbers, dots, underscores or hyphens; start with a letter or number.' });
      if (name === undefined) return;
      const fields: string[] = [name];
      for (const [index, field, value] of [[2, 'Version', '1.0.0'], [3, 'Description', `APM project: ${name}`], [4, 'Author', '']] as const) {
        const answer = await vscode.window.showInputBox({ title: `Initialize APM project (${index}/5)`, prompt: `${field} (optional; leave blank to use APM's default)`, value, ignoreFocusOut: true,
          validateInput: text => /[\r\n\0]/.test(text) ? `${field} cannot contain line breaks or NUL.` : undefined });
        if (answer === undefined) return;
        fields.push(answer.trim());
      }
      const help = await this.client(scope).execute(['compile', '--help']);
      if (help.exitCode !== 0) throw new Error('Could not read the CLI target choices. Review APM Output before initializing.');
      const targets = parseTargets(help.stdout);
      if (!targets.length) throw new Error('This APM CLI does not list supported initialization targets. Upgrade APM before initializing.');
      const selected = await vscode.window.showQuickPick(targets.filter(target => target !== 'all').map(label => ({ label })), {
        title: 'Initialize APM project (5/5)', placeHolder: 'Choose target harnesses; leave empty to use APM auto-detection',
        canPickMany: true, ignoreFocusOut: true
      });
      if (selected === undefined) return;
      if (selected.length) options['--target'] = selected.map(target => target.label).join(',');
      args.project_name = '.';
      inputLines = [...fields, 'y'];
    }
    const context: PanelContext = { mode: 'native', scope, extra: {} };
    this.nativeOperations.add(context);
    try { await this.runCommand({ type: 'command', id: command.id, args, options }, context, inputLines); }
    finally { this.nativeOperations.delete(context); }
    if (!context.extra.result) return;
    if (context.extra.error && !context.extra.actionResult?.audit) throw new Error(context.extra.error);
    if (workflow === 'initialize') {
      const manifest = await vscode.workspace.openTextDocument(vscode.Uri.file(projectManifestPath(scope.path)));
      const parsed = parseDocument(manifest.getText());
      for (const [index, key] of ['name', 'version', 'description', 'author'].entries()) {
        if (inputLines?.[index] && parsed.get(key) !== inputLines[index]) throw new Error(`APM initialization did not preserve the selected ${key}. Review apm.yml and APM Output.`);
      }
      await vscode.window.showTextDocument(manifest);
    } else if (workflow === 'auditWorkspace') {
      await vscode.commands.executeCommand('workbench.actions.view.problems');
      const audit = context.extra.actionResult?.audit;
      void vscode.window.showInformationMessage(audit?.passed ? `APM audit passed in ${scope.label}.` :
        `APM audit reported findings or incomplete coverage in ${scope.label}. Review Problems.`, 'Show Output').then(choice => {
        if (choice) this.output.show();
      });
    } else if (workflow === 'previewCompile' || workflow === 'doctor') {
      await this.showTextResult(workflow === 'previewCompile' ? 'Compilation preview' : 'APM health check', context.extra.result);
    } else {
      void vscode.window.showInformationMessage(`APM ${workflow === 'validate' ? 'validation' : 'compilation'} completed in ${scope.label}.`, 'Show Output').then(choice => {
        if (choice) this.output.show();
      });
    }
  }
  async reviewExecutableTrust() {
    this.requireTrust();
    const scope = await this.workflowScope(undefined, undefined, true);
    if (!scope) return;
    const reports = [
      { label: 'Policy status', description: 'Discovery source, cache, and effective rules', title: 'APM policy status', args: ['policy', 'status', '--json'], json: true },
      { label: 'Pending executable approvals', description: 'Packages with unapproved executable primitives', title: 'Pending executable approvals', args: ['approve', '--pending'] },
      { label: 'Effective trust decisions', description: 'Current executable allow and deny decisions', title: 'Effective executable trust decisions', args: ['approve', '--list'] }
    ];
    const picked = await vscode.window.showQuickPick(reports, {
      title: `Review executable trust — ${scope.label}`,
      placeHolder: 'Choose a read-only policy report'
    });
    if (!picked) return;
    await this.showPolicyReport(scope, picked.title, picked.args, picked.json);
  }
  async marketplaceHealth() {
    this.requireTrust();
    const scope = await this.workflowScope(undefined, undefined, true);
    if (!scope) return;
    const reports = [
      { label: 'Check marketplace entries (network)', description: 'Resolve entries from the project marketplace configuration', title: 'Marketplace entry check', args: ['marketplace', 'check'] },
      { label: 'Check marketplace entries (offline)', description: 'Validate schema and cached refs without network access', title: 'Offline marketplace entry check', args: ['marketplace', 'check', '--offline'] },
      { label: 'Show outdated marketplace packages (network)', description: 'Look for available upgrades', title: 'Outdated marketplace packages', args: ['marketplace', 'outdated'] },
      { label: 'Show outdated packages (offline)', description: 'Use cached refs only', title: 'Offline outdated marketplace packages', args: ['marketplace', 'outdated', '--offline'] },
      { label: 'Validate a registered marketplace', description: 'Check marketplace structure and plugin schema', title: 'Marketplace validation', args: ['marketplace', 'validate'], marketplaceCommand: 'validate' as const },
      { label: 'Audit marketplace dependencies (may fetch refs)', description: 'Check whether plugin dependencies resolve through the marketplace', title: 'Marketplace dependency audit', args: ['marketplace', 'audit'], marketplaceCommand: 'audit' as const }
    ];
    const picked = await vscode.window.showQuickPick(reports, {
      title: `Marketplace health — ${scope.label}`,
      placeHolder: 'Choose a read-only check; network actions are labeled'
    });
    if (!picked) return;
    const args = [...picked.args];
    let title = `${picked.title} — ${scope.label}`;
    if ('marketplaceCommand' in picked) {
      if (!this.state.marketplaces.length) throw new Error('No registered marketplaces are available to validate or audit.');
      const selected = await vscode.window.showQuickPick(this.state.marketplaces.map(marketplace => ({
        label: marketplace.name, marketplace
      })), { title: picked.title, placeHolder: 'Choose a registered marketplace' });
      if (!selected) return;
      args.push(selected.marketplace.name);
      title = `${picked.title}: ${selected.marketplace.name} — ${scope.label}`;
    }
    const result = await this.executeInspection(scope, title, args);
    if (!result) return;
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    if (result.exitCode === 0 && !output) throw new Error('APM returned an empty marketplace health report. Review APM Output.');
    await this.showTextResult(title, `Exit code: ${result.exitCode}\n\n${output || 'APM exited without returning report text.'}`);
    if (result.exitCode !== 0) {
      void vscode.window.showWarningMessage(`${title} reported findings or exited with code ${result.exitCode}. Review the result document and APM Output.`);
    } else {
      void vscode.window.showInformationMessage(`${title} completed. Review the result document for details.`);
    }
  }
  async discoverMcpServers() {
    const scope = await this.workflowScope();
    if (!scope) return;
    const actions = [
      { label: 'List MCP servers (registry/network)', description: 'Browse the configured registry', command: 'list', title: 'MCP registry servers' },
      { label: 'Search MCP servers (registry/network)', description: 'Search by keyword or phrase', command: 'search', title: 'MCP registry search' },
      { label: 'Show MCP server details (registry/network)', description: 'Look up an exact registry name', command: 'show', title: 'MCP server details' }
    ];
    const action = await vscode.window.showQuickPick(actions, {
      title: `Discover MCP servers — ${scope.label}`,
      placeHolder: 'Choose an explicit registry query'
    });
    if (!action) return;
    const args = ['mcp', action.command];
    let title = `${action.title} — ${scope.label}`;
    if (action.command !== 'list') {
      const search = action.command === 'search';
      const value = await vscode.window.showInputBox({
        title: search ? 'Search MCP registry' : 'Show MCP server details',
        prompt: search ? 'Enter a keyword or phrase' : 'Enter the exact MCP registry name',
        validateInput: input => {
          const trimmed = input.trim();
          if (!trimmed || trimmed.startsWith('-') || /[\r\n\0]/.test(input) || containsUrlCredentials(trimmed)) {
            return 'Enter a non-empty value without leading flags, line breaks, NUL, or URL credentials.';
          }
          if (!search && /\s/.test(trimmed)) return 'Enter the exact registry name without whitespace.';
          return undefined;
        }
      });
      if (value === undefined) return;
      args.push(value.trim());
      if (!search) title = `${action.title}: ${value.trim()} — ${scope.label}`;
    }
    const result = await this.executeInspection(scope, title, args);
    if (!result) return;
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    if (result.exitCode === 0 && !output) throw new Error('APM returned an empty MCP registry report. Review APM Output.');
    await this.showTextResult(title, `Exit code: ${result.exitCode}\n\n${output || 'APM exited without returning report text.'}`);
    if (result.exitCode !== 0) {
      void vscode.window.showWarningMessage(`${title} reported findings or exited with code ${result.exitCode}. Review the result document and APM Output.`);
    } else {
      void vscode.window.showInformationMessage(`${title} completed. Review the result document for details.`);
    }
  }
  async lifecycleWorkflows() {
    const scope = await this.workflowScope(undefined, undefined, true);
    if (!scope) return;
    const actions: (
      | { label: string; description: string; actionType: 'report'; args: string[]; title: string }
      | { label: string; description: string; actionType: 'test'; execute: boolean }
      | { label: string; description: string; actionType: 'command'; id: string; options: Record<string, unknown>; title: string }
    )[] = [
      { label: 'Inspect discovered lifecycle scripts', description: 'List scripts APM discovers from project, user, and policy sources', actionType: 'report', args: ['lifecycle'], title: 'Discovered lifecycle scripts' },
      { label: 'Validate lifecycle scripts', description: 'Check discovered script files without running them', actionType: 'report', args: ['lifecycle', 'validate'], title: 'Lifecycle script validation' },
      { label: 'Test lifecycle event (dry run)', description: 'Preview matching scripts without running commands or requests', actionType: 'test', execute: false },
      { label: 'Execute lifecycle event scripts', description: 'Run project-defined scripts; explicit confirmation required', actionType: 'test', execute: true },
      { label: 'Trust project lifecycle scripts', description: 'Allow this project lifecycle block to run during installs', actionType: 'command', id: 'lifecycle trust', options: {}, title: 'Trust project lifecycle scripts' },
      { label: 'Revoke lifecycle trust', description: 'Prevent this project lifecycle block from running during installs', actionType: 'command', id: 'lifecycle untrust', options: {}, title: 'Revoke project lifecycle trust' },
      { label: 'Add starter lifecycle block', description: 'Add an example lifecycle block to apm.yml', actionType: 'command', id: 'lifecycle init', options: {}, title: 'Add starter lifecycle block' },
      { label: 'Replace lifecycle block (overwrite)', description: 'Overwrite the existing lifecycle definition in apm.yml', actionType: 'command', id: 'lifecycle init', options: { '--force': true }, title: 'Replace lifecycle block' }
    ];
    const action = await vscode.window.showQuickPick(actions, {
      title: `Lifecycle workflows — ${scope.label}`,
      placeHolder: 'Choose an explicit inspection, test, or trust action'
    });
    if (!action) return;
    if (action.actionType === 'report') {
      await this.showLifecycleReport(scope, `${action.title} — ${scope.label}`, action.args);
      return;
    }
    if (action.actionType === 'test') {
      const events = ['pre-install', 'post-install', 'pre-update', 'post-update', 'pre-uninstall', 'post-uninstall'];
      const event = await vscode.window.showQuickPick(events.map(label => ({ label })), {
        title: action.execute ? 'Execute lifecycle event scripts' : 'Dry-run lifecycle event',
        placeHolder: 'Choose one of the six lifecycle events'
      });
      if (!event) return;
      const args = { event: event.label };
      const title = `${action.execute ? 'Executed' : 'Dry-run'} lifecycle event: ${event.label} — ${scope.label}`;
      if (action.execute) await this.runLifecycleCommand(scope, 'lifecycle test', args, { '--execute': true }, title);
      else await this.showLifecycleReport(scope, title, ['lifecycle', 'test', event.label]);
      return;
    }
    if (!await hasProjectManifest(scope.path)) throw new Error(`Initialize an APM project in ${scope.label} before changing its lifecycle configuration.`);
    await this.runLifecycleCommand(scope, action.id, {}, action.options, `${action.title} — ${scope.label}`);
  }
  async moreActions() {
    const actions = [
      { label: 'Dependency Reports', description: 'Check outdated packages or generate an SBOM', run: () => this.dependencyReports() },
      { label: 'View Dependency Tree', description: 'Inspect the selected scope dependency tree', run: () => this.refreshDependencyTree() },
      { label: 'Explain Dependency', description: 'Inspect why an installed package is present', run: () => this.explainDependency() },
      { label: 'Find File Owner', description: 'Find which APM package deployed a file', run: () => this.findDependencyFile() },
      { label: 'Review Executable Trust', description: 'Review executable policy and pending approvals', run: () => this.reviewExecutableTrust() },
      { label: 'Manage Executable Trust', description: 'Approve or deny a package executable primitives', run: () => this.manageExecutableTrust() },
      { label: 'Explain Package Policy', description: 'Inspect a package effective policy decision', run: () => this.workflow('policy') },
      { label: 'Check Marketplace Health', description: 'Check marketplace packages and dependency health', run: () => this.marketplaceHealth() },
      { label: 'Discover MCP Servers', description: 'Search the configured MCP registry', run: () => this.discoverMcpServers() },
      { label: 'Install MCP Server', description: 'Install a server from the configured MCP registry', run: () => this.installMcpServer() },
      { label: 'Manage Lifecycle Workflows', description: 'Inspect and manage APM lifecycle scripts', run: () => this.lifecycleWorkflows() }
    ];
    const selected = await vscode.window.showQuickPick(actions, {
      title: 'More APM actions',
      placeHolder: 'Search dependency, policy, marketplace, MCP, and lifecycle workflows'
    });
    await selected?.run();
  }
  async dependencyReports() {
    const scope = await this.workflowScope();
    if (!scope) return;
    const actions = [
      { label: 'Check outdated dependencies (network)', description: 'Run APM remote version checks for this scope', actionType: 'outdated' },
      { label: 'View SBOM in editor', description: 'Generate CycloneDX or SPDX output without writing a file', actionType: 'view' },
      { label: 'Save SBOM to file...', description: 'Write a CycloneDX or SPDX file to a location you choose', actionType: 'save' }
    ];
    const action = await vscode.window.showQuickPick(actions, {
      title: `Dependency reports — ${scope.label}`,
      placeHolder: 'Choose a report; outdated checks may use the network'
    });
    if (!action) return;
    if (action.actionType === 'outdated') {
      const context: PanelContext = { mode: 'native', scope, extra: {} };
      this.nativeOperations.add(context);
      try { await this.runCommand({ type: 'command', id: 'outdated', args: {}, options: {} }, context); }
      finally { this.nativeOperations.delete(context); }
      if (!context.extra.result) return;
      const title = `Outdated dependencies — ${scope.label}`;
      await this.showTextResult(title, context.extra.result);
      if (context.extra.error) throw new Error(context.extra.error);
      void vscode.window.showInformationMessage(`${title} completed. Review the result document for details.`);
      return;
    }
    const formats = [
      { label: 'CycloneDX JSON', value: 'cyclonedx', filename: 'apm-sbom.cdx.json' },
      { label: 'SPDX JSON', value: 'spdx', filename: 'apm-sbom.spdx.json' }
    ];
    const format = await vscode.window.showQuickPick(formats, {
      title: 'Choose SBOM format',
      placeHolder: 'Select a supported APM lock export format'
    });
    if (!format) return;
    if (action.actionType === 'view') {
      const args = ['lock', 'export', ...(scope.kind === 'global' ? ['--global'] : []), '--format', format.value];
      await this.showDependencyReport(scope, `${format.label} SBOM — ${scope.label}`, args);
      return;
    }
    const destination = await vscode.window.showSaveDialog({
      title: `Save ${format.label} SBOM`,
      defaultUri: vscode.Uri.file(join(scope.path, format.filename)),
      filters: { [format.label]: ['json'] }
    });
    if (!destination) return;
    if (destination.scheme !== 'file') throw new Error('Choose a file-system location for the SBOM.');
    const outputPath = destination.fsPath;
    const title = `${format.label} SBOM export — ${scope.label}`;
    const confirmation = await vscode.window.showWarningMessage(
      `Write the ${format.value} SBOM from ${scope.label} to ${outputPath}? Host: ${this.hostLabel()}. APM reads the selected lockfile and writes only this report file.`,
      'Write SBOM');
    if (confirmation !== 'Write SBOM') return;
    const args = ['lock', 'export', ...(scope.kind === 'global' ? ['--global'] : []), '--format', format.value, '--output', outputPath];
    const result = await this.serialize('apm-mutations', () => this.executeInspection(scope, title, args));
    if (!result) return;
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    if (result.exitCode === 0 && !output) throw new Error('APM returned no confirmation for the SBOM file. Review APM Output.');
    await this.showTextResult(title, `Exit code: ${result.exitCode}\n\n${output || 'APM exited without returning report text.'}`);
    if (result.exitCode !== 0) {
      void vscode.window.showWarningMessage(`${title} exited with code ${result.exitCode}. Review the result document and APM Output.`);
      return;
    }
    void vscode.window.showInformationMessage(`SBOM written to ${outputPath}.`, 'Open SBOM').then(choice => {
      if (choice) void vscode.workspace.openTextDocument(vscode.Uri.file(outputPath))
        .then(document => vscode.window.showTextDocument(document))
        .then(undefined, error => this.report(error));
    });
  }
  private async showDependencyReport(scope: Scope, title: string, args: string[], validate?: (output: string) => void) {
    const result = await this.executeInspection(scope, title, args);
    if (!result) return;
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    if (result.exitCode === 0 && !output) throw new Error('APM returned an empty dependency report. Review APM Output.');
    if (result.exitCode === 0) validate?.(result.stdout);
    await this.showTextResult(title, `Exit code: ${result.exitCode}\n\n${output || 'APM exited without returning report text.'}`);
    if (result.exitCode !== 0) {
      void vscode.window.showWarningMessage(`${title} reported findings or exited with code ${result.exitCode}. Review the result document and APM Output.`);
    } else {
      void vscode.window.showInformationMessage(`${title} completed. Review the result document for details.`);
    }
  }
  private async showLifecycleReport(scope: Scope, title: string, args: string[]) {
    const result = await this.executeInspection(scope, title, args);
    if (!result) return;
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    if (result.exitCode === 0 && !output) throw new Error('APM returned an empty lifecycle report. Review APM Output.');
    await this.showTextResult(title, `Exit code: ${result.exitCode}\n\n${output || 'APM exited without returning report text.'}`);
    if (result.exitCode !== 0) {
      void vscode.window.showWarningMessage(`${title} reported findings or exited with code ${result.exitCode}. Review the result document and APM Output.`);
    } else {
      void vscode.window.showInformationMessage(`${title} completed. Review the result document for details.`);
    }
  }
  private async runLifecycleCommand(scope: Scope, id: string, args: Record<string, string>, options: Record<string, unknown>, title: string) {
    const context: PanelContext = { mode: 'native', scope, extra: {} };
    this.nativeOperations.add(context);
    try { await this.runCommand({ type: 'command', id, args, options }, context); }
    finally { this.nativeOperations.delete(context); }
    if (!context.extra.result) return;
    await this.showTextResult(title, context.extra.result);
    if (context.extra.error) throw new Error(context.extra.error);
    void vscode.window.showInformationMessage(`${title} completed. Review the result document for details.`);
  }
  async manageExecutableTrust() {
    this.requireTrust();
    const selectedScope = await vscode.window.showQuickPick(this.state.scopes.map(scope => ({
      label: scope.kind === 'global' ? 'Global (user)' : scope.label,
      description: scope.path,
      detail: scopeKey(scope) === this.state.scopeKey ? 'Current package scope' : undefined,
      scope
    })), { title: 'Choose package scope', placeHolder: 'Select where the package is installed' });
    if (!selectedScope) return;
    const scope = { ...selectedScope.scope };
    const installed = await this.client(scope).getInstalled(scope);
    if (!installed.length) throw new Error(`No installed dependencies are available in ${scope.label}.`);
    const picked = await vscode.window.showQuickPick(installed.map(item => ({
      label: item.name,
      description: item.version,
      detail: scope.label,
      item
    })), { title: `Choose package — ${scope.label}`, placeHolder: 'Select a package to change executable trust for' });
    if (!picked) return;
    const packageName = packageIdentity(picked.item, picked.item, false);
    if (!packageName || packageName.startsWith('-') || /[\s\0]/.test(packageName)) {
      throw new Error('APM returned an invalid dependency identity.');
    }
    const action = await vscode.window.showQuickPick([
      { label: 'Approve executable primitives', description: 'Grant this package permission to use its declared executables', command: 'approve' },
      { label: 'Deny executable primitives', description: "Block this package's executable primitives; deny takes precedence", command: 'deny' }
    ], { title: `Manage executable trust — ${packageName}`, placeHolder: 'Choose an explicit trust decision' });
    if (!action) return;
    const destinations = [
      ...(scope.kind === 'workspace' && await hasProjectManifest(scope.path)
        ? [{ label: 'Shared project policy', description: 'Write the decision to apm.yml', user: false }]
        : []),
      { label: 'Personal policy', description: 'Write the decision to ~/.apm/config.json', user: true }
    ];
    const destination = await vscode.window.showQuickPick(destinations, {
      title: `Store trust decision — ${packageName}`,
      placeHolder: 'Choose the policy destination; package scope stays unchanged'
    });
    if (!destination) return;
    const context: PanelContext = { mode: 'native', scope, extra: {} };
    this.nativeOperations.add(context);
    try {
      await this.runCommand({
        type: 'command',
        id: action.command,
        args: { packages: packageName },
        options: destination.user ? { '--user': true } : {}
      }, context);
    } finally { this.nativeOperations.delete(context); }
    if (context.extra.result && !context.extra.error) {
      await this.showTextResult(`${action.label}: ${packageName}`, context.extra.result);
    }
  }
  private async showPolicyReport(scope: Scope, title: string, args: string[], json = false) {
    const result = await this.executeInspection(scope, title, args);
    if (!result) return;
    if (result.exitCode !== 0) throw new Error(`APM policy inspection failed: ${redact(result.stderr || result.stdout)}`);
    let output = result.stdout.trim();
    if (json) {
      try { output = JSON.stringify(JSON.parse(output), null, 2); }
      catch { throw new Error('APM returned an invalid policy status report. Review APM Output.'); }
    }
    if (result.stderr.trim()) output = [output, result.stderr.trim()].filter(Boolean).join('\n');
    if (!output) throw new Error('APM returned an empty policy report. Review APM Output.');
    await this.showTextResult(title, output);
  }
  private async executeInspection(scope: Scope, title: string, args: string[]) {
    this.requireTrust();
    const capturedScope = { ...scope };
    const controller = new AbortController();
    const context: PanelContext = { mode: 'native', scope: capturedScope, controller, extra: {} };
    this.nativeOperations.add(context);
    try {
      this.output.appendLine(`\n$ apm ${redact(args.join(' '))} (${capturedScope.label})`);
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title, cancellable: true
      }, async (_progress, cancellation) => {
        const subscription = cancellation.onCancellationRequested(() => controller.abort());
        try {
          return await this.client(capturedScope, controller.signal).execute(args, {
            signal: controller.signal, timeoutMs: 5 * 60_000
          });
        } finally { subscription.dispose(); }
      });
      if (controller.signal.aborted) return;
      return result;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally { this.nativeOperations.delete(context); }
  }
  async refreshDependencyTree(capturedScope?: Scope) {
    const scope = { ...(capturedScope ?? this.scope()) };
    await this.showDependencyReport(scope, `Dependency tree — ${scope.label}`,
      ['deps', 'tree', ...(scope.kind === 'global' ? ['--global'] : [])], output => { parseDependencyTree(output); });
  }
  async explainDependency(target?: unknown, capturedScope?: Scope) {
    this.requireTrust();
    const scope = { ...(capturedScope ?? this.scope()) };
    let packageName = typeof target === 'string' ? target : undefined;
    if (!packageName) {
      const installed = await this.client(scope).getInstalled(scope);
      if (!installed.length) throw new Error(`No installed dependencies are available in ${scope.label}.`);
      const picked = await vscode.window.showQuickPick(installed.map(dependency => ({
        label: dependency.name, description: dependency.version, dependency
      })), { title: `Explain APM dependency — ${scope.label}`, placeHolder: 'Choose an installed dependency' });
      if (!picked) return;
      packageName = packageIdentity(picked.dependency, picked.dependency, false);
    }
    if (packageName.startsWith('-') || /[\s\0]/.test(packageName)) throw new Error('APM returned an invalid dependency identity.');
    const result = await this.executeInspection(scope, `Why ${packageName} is installed`, [
      'deps', 'why', ...(scope.kind === 'global' ? ['--global'] : []), packageName, '--json'
    ]);
    if (!result) return;
    if (result.exitCode !== 0) throw new Error(`Dependency explanation failed: ${redact(result.stderr || result.stdout)}`);
    let formatted: string;
    try { formatted = JSON.stringify(JSON.parse(result.stdout), null, 2); }
    catch { throw new Error('APM returned an invalid dependency explanation. Review APM Output.'); }
    await this.showTextResult(`Why ${packageName} is installed`, formatted);
  }
  async findDependencyFile(target?: unknown) {
    this.requireTrust();
    let uri = target instanceof vscode.Uri ? target : vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      const scope = await this.workflowScope(undefined, undefined, true);
      if (!scope) return;
      const selected = await vscode.window.showOpenDialog({
        title: 'Find the APM package that deployed a file',
        defaultUri: vscode.Uri.file(scope.path),
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false
      });
      uri = selected?.[0];
    }
    if (!uri) return;
    if (uri.scheme !== 'file') throw new Error('Select a file from a filesystem workspace.');
    const scope = await this.workflowScope(uri, undefined, true);
    if (!scope) return;
    const path = relative(scope.path, uri.fsPath);
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new Error('Select a file inside the APM project folder.');
    }
    const metadata = await vscode.workspace.fs.stat(uri);
    if (metadata.type !== vscode.FileType.File) throw new Error('Select a file, not a folder.');
    const result = await this.client(scope).execute(['find', path, '--path', '--source']);
    if (result.exitCode !== 0) throw new Error(`APM could not trace this file: ${redact(result.stderr || result.stdout)}`);
    await this.showTextResult(`APM file ownership: ${path}`, result.stdout);
  }
  private async showTextResult(title: string, content: string) {
    const uri = vscode.Uri.from({ scheme: 'apm-result', path: `/${title.replace(/[^a-zA-Z0-9._-]/g, '-')}.txt`, query: String(++this.resultId) });
    this.results.set(uri.toString(), `${title}\n\n${redact(content)}`);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
  }
  async installPackage(capturedScope?: Scope, preview = false) {
    const scope = await this.installScope(capturedScope);
    if (!scope) return;
    const choices = [
      { label: '$(edit) Enter package source...', description: 'Repository or marketplace package', item: undefined as PackageItem | undefined },
      ...this.state.catalog.map(item => ({ label: item.name, description: item.marketplace ?? item.source, detail: item.description, item }))
    ];
    const picked = await vscode.window.showQuickPick(choices, { title: preview ? 'Preview package installation' : 'Install APM package',
      placeHolder: `Choose a package for ${scope.label}`, matchOnDescription: true, matchOnDetail: true });
    if (!picked) return;
    let item = picked.item;
    if (!item) {
      const source = await vscode.window.showInputBox({ title: 'Install APM package', prompt: 'Package source, for example owner/repository or package@marketplace',
        validateInput: value => !value.trim() || value.startsWith('-') || /[\s\0]/.test(value) || containsUrlCredentials(value)
          ? 'Enter a package source without whitespace, leading flags, or credentials.' : undefined });
      if (source === undefined) return;
      item = { id: source, name: source, source, marketplace: '', version: '', installed: false };
    }
    const context: PanelContext = { mode: 'details', scope, item, extra: {} };
    this.nativeOperations.add(context);
    try { await this.packageAction(preview ? 'previewInstall' : 'install', context, true); }
    finally { this.nativeOperations.delete(context); }
    const result = context.extra.actionResult;
    if (!result) return;
    if (result.status === 'failed') return;
    if (result.status === 'cancelled') {
      void vscode.window.showInformationMessage(`APM installation cancelled in ${scope.label}. Partial changes may remain.`, 'Show Output').then(choice => {
        if (choice) this.output.show();
      });
      return;
    }
    if (preview) await this.showTextResult(`Installation preview for ${item.name}`, result.output ?? result.summary ?? '');
    else {
      void vscode.window.showInformationMessage(`${item.name} installed in ${scope.label}.`, 'Open Package').then(choice => {
        if (choice) void this.openPackageDetails(context.item ?? item, scope).catch(error => this.report(error));
      });
    }
  }
  async installMcpServer() {
    const scope = await this.installScope();
    if (!scope) return;
    const name = await vscode.window.showInputBox({
      title: `Install MCP server — ${scope.label}`,
      prompt: 'Enter the exact MCP registry name',
      validateInput: value => {
        const trimmed = value.trim();
        return !trimmed || trimmed.startsWith('-') || /[\s\0]/.test(trimmed) || containsUrlCredentials(trimmed)
          ? 'Enter a registry name without whitespace, leading flags, NUL, or URL credentials.'
          : undefined;
      }
    });
    if (name === undefined) return;
    const serverName = name.trim();
    const context: PanelContext = { mode: 'native', scope, extra: {} };
    this.nativeOperations.add(context);
    try {
      await this.runCommand({
        type: 'command',
        id: 'install',
        args: {},
        options: { '--mcp': serverName }
      }, context);
    } finally { this.nativeOperations.delete(context); }
    if (!context.extra.result) return;
    const title = `MCP server installation: ${serverName} — ${scope.label}`;
    await this.showTextResult(title, context.extra.result);
    if (context.extra.error) throw new Error(context.extra.error);
    void vscode.window.showInformationMessage(`${serverName} installed in ${scope.label}. Review the result document for details.`);
  }
  private async installScope(preferred = this.scope()): Promise<Scope | undefined> {
    this.requireTrust();
    const candidates = this.state.scopes.filter(scope => scope.kind === 'workspace');
    const workspaces = (await Promise.all(candidates.map(async scope => ({
      scope, present: await hasProjectManifest(scope.path)
    })))).filter(entry => entry.present).map(entry => entry.scope);
    const preferredWorkspace = workspaces.find(scope => isSameScope(scope, preferred)) ?? workspaces[0];
    const defaultScope = preferredWorkspace ?? this.globalScope();
    const scopes = [defaultScope, ...[...workspaces, this.globalScope()].filter(scope => !isSameScope(scope, defaultScope))];
    const picked = await vscode.window.showQuickPick(scopes.map(scope => ({
      label: scopeLabel(scope),
      description: isSameScope(scope, defaultScope) ? 'Default' : undefined,
      detail: `${scope.path} — ${this.hostLabel()}`, scope
    })), { title: 'Install APM package: destination', placeHolder: 'Choose global or workspace installation' });
    return picked ? { ...picked.scope } : undefined;
  }
  private async runProjectScript(scope: Scope) {
    const uri = vscode.Uri.file(scope.path), settings = vscode.workspace.getConfiguration('apm', uri);
    if (!settings.get<boolean>('tasks.includeScripts', false)) throw new Error('Enable apm.tasks.includeScripts in Settings to run project scripts. Scripts execute project-defined commands.');
    const text = await readProjectManifest(scope.path);
    if (text === undefined) throw new Error('This project has no apm.yml. Initialize it before running scripts.');
    const document = parseDocument(text);
    if (document.errors.length) throw new Error(`Cannot read APM scripts: ${document.errors[0].message}`);
    const manifest: unknown = document.toJS(), scripts = record(manifest) && record(manifest.scripts) ? manifest.scripts : {};
    const choices = Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([label, script]) => ({ label, description: redact(script) }));
    if (!choices.length) throw new Error('No named scripts are declared in apm.yml.');
    const picked = await vscode.window.showQuickPick(choices, { title: 'Run APM project script', placeHolder: 'Choose a manifest script' });
    if (!picked) return;
    const task = (await vscode.tasks.fetchTasks({ type: 'apm' })).find(task => task.definition.workflow === 'script' &&
      task.definition.script === picked.label && typeof task.scope !== 'number' && task.scope?.uri.fsPath === scope.path);
    if (!task) throw new Error('The selected script task is no longer available. Review apm.yml and try again.');
    await vscode.tasks.executeTask(task);
  }
  async findDependency(dependency: string, uri?: vscode.Uri) {
    this.requireTrust();
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    const scope = folder ? { kind: 'workspace' as const, label: folder.name, path: folder.uri.fsPath } : { ...this.scope() };
    const installed = scopeKey(scope) === this.state.scopeKey
      ? this.state.installed.filter(item => !item.scope || isSameScope(item.scope, scope))
      : await this.client(scope).getInstalled(scope);
    const item = [...installed, ...this.state.catalog].find(item => item.name === dependency || item.source === dependency ||
      item.metadata?.cliIdentity === dependency || item.metadata?.installExpression === dependency);
    if (item) await this.openPackageDetails(item, scope);
    else {
      const result = await this.client(scope).execute(['view', dependency]);
      if (result.exitCode !== 0) throw new Error(redact(result.stderr || result.stdout || 'Could not inspect this dependency.'));
      await this.showTextResult(`Package: ${dependency}`, result.stdout);
    }
  }
  async showTargets(context = this.sidebar, uri?: vscode.Uri) {
    const scope = await this.workflowScope(uri, context?.scope, true);
    if (!scope) return;
    const client = this.client(scope);
    if (!await client.supports(['targets'], ['--json'])) throw new Error('This APM CLI cannot report targets as JSON. Upgrade APM.');
    const result = await client.execute(['targets', '--json']);
    if (result.exitCode !== 0) throw new Error(`Target discovery failed: ${redact(result.stderr || result.stdout)}`);
    const targets = resolvedTargets(result.stdout);
    const picked = await vscode.window.showQuickPick(targets.map(target => ({
      label: target.target, description: target.status,
      detail: [target.source, target.deployDir, target.needs].filter(Boolean).join(' — '), target
    })), { title: `APM deployment targets — ${scope.label}`, placeHolder: 'Select a target to locate its project configuration' });
    if (!picked) return;
    await this.configureTargets({ mode: 'native', scope, extra: {} });
  }
  private async configureTargets(context: PanelContext) {
    this.requireTrust();
    const scope = this.scope(context);
    if (scope.kind !== 'workspace') throw new Error('Open a workspace folder to configure project targets.');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(projectManifestPath(scope.path)));
    const editor = await vscode.window.showTextDocument(document);
    const offset = document.getText().search(/^targets?:/m);
    if (offset >= 0) { const position = document.positionAt(offset); editor.selection = new vscode.Selection(position, position); editor.revealRange(new vscode.Range(position, position)); }
  }
  private async openTarget(target: string, context: PanelContext) {
    this.requireTrust();
    const row = context.extra.targets?.find(row => row.target === target);
    if (!row?.deployDir) throw new Error('This target has no deployment directory. Refresh targets.');
    const actual = await resolveContained(this.scope(context).path, row.deployDir);
    if (!actual) throw new Error('The deployment directory does not exist yet. Install or compile for this target first.');
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(actual));
  }
  updateFilterContext() {
    const tokens = filterTokens(this.search);
    const keys: Record<string, unknown> = {
      'apm.filter.installed': tokens.installed, 'apm.filter.updates': tokens.updates, 'apm.filter.dependencies': tokens.dependencies, 'apm.filter.sort': tokens.sort,
      'apm.filter.marketplace': tokens.marketplace, 'apm.filter.scopeKind': tokens.scope
    };
    for (const section of ['catalog', 'installed', 'updates'] as const) keys[`apm.views.${section}`] = !this.state.hiddenSections?.includes(section);
    for (const [key, value] of Object.entries(keys)) void vscode.commands.executeCommand('setContext', key, value);
  }
  async toggleSection(section: PackageSection) {
    const hidden = this.state.hiddenSections ?? [];
    const next = hidden.includes(section) ? hidden.filter(value => value !== section) : [...hidden, section];
    await this.context.workspaceState.update('hiddenSections', next);
    this.state.hiddenSections = next;
    this.updateFilterContext();
    this.broadcast();
  }
  private setSearch(search: string) {
    this.search = search; this.updateFilterContext();
    void Promise.resolve(this.context.workspaceState.update('browserSearch', search)).catch(error => this.report(error));
    if (this.sidebar) void this.sidebar.webview?.postMessage({ type: 'setSearch', search });
    this.broadcast();
  }
  toggleStatus(status: '@installed' | '@updates' | '@dependencies') {
    const tokens = filterTokens(this.search), on = status === '@installed' ? tokens.installed : status === '@updates' ? tokens.updates : tokens.dependencies;
    this.setSearch(withStatus(this.search, on ? '' : status));
  }
  sortBy(order: Ordering) { this.setSearch(withToken(this.search, '@sort:', order === 'name' ? '' : order)); }
  async chooseMarketplace(all = false) {
    let name = '';
    if (!all) {
      const current = filterTokens(this.search).marketplace;
      const picked = await vscode.window.showQuickPick(
        [{ label: 'All marketplaces', name: '' }, ...this.state.marketplaces.map(m => ({ label: m.name, description: redact(m.source), name: m.name }))]
          .map(item => ({ ...item, picked: item.name === current, detail: item.name === current ? 'Current filter' : undefined })),
        { title: 'Filter by Marketplace', placeHolder: 'Show packages from this marketplace' });
      if (!picked) return;
      name = picked.name;
    }
    this.setSearch(withToken(this.search, '@marketplace:', name));
  }
  async chooseScope(kind: 'workspace' | 'global' | '') {
    let target: Scope | undefined;
    if (kind === 'workspace') {
      const folders = this.state.scopes.filter(s => s.kind === 'workspace');
      if (!folders.length) { void vscode.window.showInformationMessage('Open a workspace folder to manage workspace packages.'); return; }
      target = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(
        folders.map(f => ({ label: f.label, description: f.path, detail: scopeKey(f) === this.state.scopeKey ? 'Current scope' : undefined, scope: f })),
        { title: 'Select Workspace Folder', placeHolder: 'Show and install packages for this folder' }))?.scope;
    }
    if (target && scopeKey(target) !== this.state.scopeKey) await this.selectScope(scopeKey(target));
    this.setSearch(withToken(this.search, '@scope:', filterTokens(this.search).scope === kind ? '' : kind));
  }
  private async selectScope(key: string) {
    this.epoch++; this.refreshController?.abort(); if (this.refreshing) this.refreshAgain = true;
    this.state.scopeKey = key; this.state.catalog = []; this.state.installed = []; this.state.checkedAt = undefined;
    this.state.projectPresent = undefined;
    if (this.sidebar) this.sidebar.extra.targets = undefined;
    await this.context.workspaceState.update('scopeKey', key);
    this.updateFilterContext();
    await this.refresh();
  }
  private async openDetails(id: string, key?: string) {
    this.requireTrust();
    const scope = key ? this.state.scopes.find(scope => scopeKey(scope) === key) : this.scope();
    if (!scope) throw new Error('This package scope is no longer available.');
    const catalog = this.state.catalog.find(item => item.id === id);
    const item = this.state.installed.find(i => i.id === id && inScope(i, scope))
      ?? (key ? undefined : this.state.installed.find(i => i.id === id))
      ?? (catalog ? { ...catalog, scope, installed: false, updateStatus: undefined, latestVersion: undefined, updateStale: undefined } : undefined);
    if (!item) throw new Error('Package is no longer available. Refresh and retry.');
    await this.openPackageDetails(item, { ...(item.scope ?? scope) });
  }
  private async openPackageDetails(item: PackageItem, scope: Scope) {
    this.requireTrust();
    const key = `details:${scopeKey(scope)}:${item.id}`;
    let entry = this.panels.get(key);
    if (!entry) {
      const panel = vscode.window.createWebviewPanel('apm.details', item.name, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      entry = this.attach(panel.webview, 'details', panel);
      entry.scope = scope; entry.item = item;
      this.panels.set(key, entry);
      const panelEntry = entry;
      panel.onDidDispose(() => {
        panelEntry.detailsRequest = (panelEntry.detailsRequest ?? 0) + 1;
        panelEntry.detailsController?.abort();
        this.panels.delete(key);
      });
    }
    entry.item = item;
    entry.panel?.reveal();
    await this.loadDetails(entry);
    return entry;
  }
  private async loadDetails(entry: PanelContext) {
    const item = entry.item!, scope = this.scope(entry);
    entry.detailsController?.abort();
    const controller = entry.detailsController = new AbortController();
    const request = entry.detailsRequest = (entry.detailsRequest ?? 0) + 1;
    entry.extra = { ...entry.extra, busy: true, error: undefined, details: undefined, readmeHtml: undefined, readmeImagesBlocked: undefined };
    this.send(entry);
    try {
      const details = await this.client(scope, controller.signal).getDetails(item, scope);
      if (request !== entry.detailsRequest) return;
      const groups = details.contents as ContentGroup[] | undefined;
      entry.navigation = typeof details.localContentRoot === 'string' && Array.isArray(groups)
        ? await contentNavigation(details.localContentRoot, groups, item.installed, typeof item.metadata?.deployedSkillPath === 'string') : new Map();
      delete details.localContentRoot;
      if (request !== entry.detailsRequest) return;
      entry.extra.details = safePayload(details) as Record<string, unknown>;
      if (typeof entry.extra.details.readme === 'string') this.setReadme(entry, entry.extra.details.readme);
    } catch (error) { if (request === entry.detailsRequest) this.report(error, entry); }
    finally {
      if (request === entry.detailsRequest) {
        entry.detailsController = undefined; entry.extra.busy = false; this.send(entry);
      }
    }
  }
  private setReadme(entry: PanelContext, text: string) {
    const rendered = renderMarkdown(text, this.allowRemoteImages());
    entry.extra.readmeHtml = rendered.html;
    entry.extra.readmeImagesBlocked = rendered.blockedImages;
    if (rendered.blockedImages.https && !this.readmeNotices.has('https')) {
      this.readmeNotices.add('https');
      void vscode.window.showInformationMessage('Remote README images are blocked for privacy. Allow HTTPS images in VS Code Settings if you trust their hosts.', 'Open Image Settings').then(choice => {
        if (choice === 'Open Image Settings') void Promise.resolve(openSettings('apm.allowRemoteImages')).catch(error => this.report(error, entry));
      });
    }
    if (rendered.blockedImages.insecure && !this.readmeNotices.has('insecure')) {
      this.readmeNotices.add('insecure');
      void vscode.window.showWarningMessage('README images with insecure HTTP or protocol-relative URLs are blocked.');
    }
  }
  private async handle(message: Message, context: PanelContext) {
    if (message.type !== 'ready' && message.type !== 'filters') context.extra.error = undefined;
    switch (message.type) {
      case 'ready': this.send(context); if (context.mode === 'browser' || !this.state.version) await this.refresh(); break;
      case 'refresh': await this.refreshAll(); break;
      case 'scope': {
        const scope = this.state.scopes.find(s => scopeKey(s) === message.key);
        if (!scope) throw new Error('Unknown APM scope.');
        if (context.mode === 'native') {
          if (context.controller || this.commandTasks.has(context)) throw new Error('Stop the current command before changing its execution scope.');
          context.scope = scope;
          context.extra.targets = undefined;
        }
        await this.selectScope(message.key); break;
      }
      case 'filters':
        if (context.mode === 'browser' && message.search !== this.search) this.setSearch(message.search);
        break;
      case 'dependencies': {
        this.requireTrust();
        const scope = this.scope(context);
        if (!this.state.scopes.some(candidate => isSameScope(candidate, scope))) throw new Error('This package scope is no longer available. Select a current workspace or global scope.');
        if (scopeKey(scope) !== this.state.scopeKey) await this.selectScope(scopeKey(scope));
        this.setSearch('@dependencies');
        await vscode.commands.executeCommand('apm.browser.focus');
        break;
      }
      case 'dependencyTree': await this.refreshDependencyTree(this.scope(context)); break;
      case 'actions': await this.moreActions(); break;
      case 'dependencyWhy': {
        const scope = this.state.scopes.find(candidate => scopeKey(candidate) === message.scopeKey);
        const item = scope && this.state.installed.find(candidate => candidate.id === message.id && inScope(candidate, scope));
        if (!scope || !item) throw new Error('This installed dependency is no longer available. Refresh and retry.');
        await this.explainDependency(packageIdentity(item, item, false), scope);
        break;
      }
      case 'chooseScope': await this.chooseAnyScope(); break;
      case 'workflow': await this.workflow(message.workflow, undefined, { ...this.scope(context) }); break;
      case 'targets': await this.showTargets(context); break;
      case 'configureTargets': await this.configureTargets(context); break;
      case 'openTarget': await this.openTarget(message.target, context); break;
      case 'retry':
        if (context.retry) await context.retry();
        else if (context.mode === 'browser') await this.refreshAll();
        else if (context.mode === 'details') await this.loadDetails(context);
        else throw new Error('Select and run an APM command before retrying.');
        break;
      case 'navigate': {
        const target = context.navigation?.get(message.id);
        if (!target) throw new Error('This file link has expired. Refresh the package or run the audit again.');
        await openNavigation(target);
        break;
      }
      case 'details': await this.openDetails(message.id, message.scopeKey); break;
      case 'install': await this.installPackage({ ...this.scope(context) }); break;
      case 'marketplaces': await openSettings('apm.marketplaces'); break;
      case 'setup': await this.setup(); break;
      case 'output': this.output.show(); break;
      case 'trust': await vscode.commands.executeCommand('workbench.trust.manage'); break;
      case 'settings': await openSettings(`@ext:${this.context.extension.id}`); break;
      case 'readmeImageSettings': await openSettings('apm.allowRemoteImages'); break;
      case 'external': {
        const uri = vscode.Uri.parse(message.url, true);
        if (!['https', 'http', 'mailto'].includes(uri.scheme) || uri.authority.includes('@')) throw new Error('Unsafe external link.');
        await vscode.env.openExternal(uri); break;
      }
      case 'packageAction': await this.packageAction(message.action, context); break;
      case 'cancel':
        if (context.mode === 'details') context.controller?.abort();
        else {
          const task = this.commandTasks.get(context);
          if (task) { task.cancelled = true; task.execution?.terminate(); }
          else if (context.controller) context.controller.abort();
          else this.refreshController?.abort();
        }
        break;
    }
  }
  private async packageAction(action: PackageAction, context: PanelContext, scopeChosen = false) {
    this.requireTrust();
    if (context.mode !== 'details' || !context.item) throw new Error('Open a package page to run package actions.');
    if (context.controller) throw new Error('Another action is already running on this page. Wait for it or cancel it.');
    context.controller = new AbortController();
    try {
      if (!scopeChosen && ['install', 'installWithOptions', 'previewInstall', 'previewWithOptions'].includes(action)) {
        const target = await this.installScope(this.scope(context));
        if (!target || context.controller.signal.aborted) return;
        if (!isSameScope(target, this.scope(context))) {
          const catalog = this.state.catalog.find(item => item.id === context.item!.id);
          const installed = findInstalledPackage({ ...context.item, scope: target }, this.state.installed);
          const item = installed ?? { ...(catalog ?? context.item), scope: target, installed: false,
            updateStatus: undefined, latestVersion: undefined, updateStale: undefined };
          if (context.panel) {
            const entry = await this.openPackageDetails(item, target);
            await this.packageAction(action, entry, true);
            return;
          }
          context.scope = target;
          context.item = item;
        }
      }
      const item = context.item, scope = this.scope(context);
      context.retry = () => this.packageAction(action, context);
      const installed = findInstalledPackage({ ...item, scope }, this.state.installed)
        ?? (item.installed && (!item.scope || isSameScope(item.scope, scope)) ? item : undefined);
      await this.dispatchPackageAction(action, context, item, installed, scope, scope.kind === 'global');
    } finally {
      context.controller = undefined;
    }
  }
  private async dispatchPackageAction(action: PackageAction, context: PanelContext, item: PackageItem, installed: PackageItem | undefined, scope: Scope, global: boolean) {
    switch (action) {
      case 'install': {
        await this.runPackageCommand(context, action, `Install ${item.name}`, 'install', { packages: packageIdentity(item, installed, true) }, global ? { '--global': true } : {}, true);
        break;
      }
      case 'previewInstall':
        await this.runPackageCommand(context, action, `Preview install ${item.name}`, 'install', { packages: packageIdentity(item, installed, true) },
          { ...(global ? { '--global': true } : {}), '--dry-run': true }, false);
        break;
      case 'previewUpdate': {
        if (!installed) throw new Error('Install this package before previewing an update.');
        const command = packageUpdateCommand(installed);
        await this.runPackageCommand(context, action, `Preview update ${item.name}`, command.id, { packages: command.packages },
          { ...(global ? { '--global': true } : {}), '--dry-run': true }, false);
        break;
      }
      case 'applyPreview': {
        const preview = context.preview;
        if (!preview || !context.extra.actionResult?.preview || context.extra.actionResult.status !== 'success') throw new Error('Run a successful preview before applying its options.');
        await this.runPackageCommand(context, preview.action, preview.title, preview.id, preview.args, preview.options, true);
        break;
      }
      case 'installWithOptions': {
        const choice = await this.chooseInstallOptions(context, item, installed);
        if (!choice) return;
        await this.runPackageCommand(context, action, `Install ${item.name}${choice.ref ? ` #${choice.ref}` : ''}`, 'install',
          { packages: withRef(packageIdentity(item, installed, true), choice.ref) },
          global ? { '--global': true } : {}, true);
        break;
      }
      case 'previewWithOptions': {
        const choice = await this.chooseInstallOptions(context, item, installed);
        if (!choice) return;
        await this.runPackageCommand(context, action, `Preview install ${item.name}`, 'install',
          { packages: withRef(packageIdentity(item, installed, true), choice.ref) },
          { ...(global ? { '--global': true } : {}), '--dry-run': true }, false);
        break;
      }
      case 'uninstall':
        if (!installed) throw new Error(`${item.name} is not installed in ${scope.label}.`);
        await this.runPackageCommand(context, action, `Uninstall ${item.name}`, 'uninstall', { packages: packageIdentity(item, installed, false) }, global ? { '--global': true } : {}, true);
        break;
      case 'update': {
        if (!installed) throw new Error(`${item.name} is not installed in ${scope.label}.`);
        const command = packageUpdateCommand(installed);
        await this.runPackageCommand(context, action, `Update ${item.name}${command.id === 'install' ? ` to ${installed.latestVersion}` : ''}`, command.id, { packages: command.packages }, global ? { '--global': true } : {}, true);
        break;
      }
      case 'audit': {
        if (global) throw new Error('APM audit scans a project. Select a workspace folder.');
        if (!installed) throw new Error(`${item.name} is not installed in ${scope.label}.`);
        const json = await this.client(scope).supports(['audit'], ['--format']);
        await this.runPackageCommand(context, action, `Audit ${item.name}`, 'audit', { package: packageIdentity(item, installed, false) }, json ? { '--format': 'json' } : {}, false, stdout => {
          const audit = json ? parseAudit(stdout) : undefined;
          if (json && !audit) throw new Error('Unrecognized APM JSON audit report. Review APM Output.');
          if (!audit) return {};
          const counts = Object.entries(audit.summary).filter(([key]) => key !== 'files_scanned' && key !== 'files_affected').map(([key, count]) => `${count} ${key}`).join(', ');
          return { audit, status: audit.passed ? 'success' : 'failed', summary: `${audit.passed ? 'Passed' : 'Audit failed'} — ${audit.summary.files_scanned ?? 0} files scanned${counts ? `; ${counts}` : ''}${audit.coverage?.complete === false ? '; scan coverage is incomplete' : ''}.` };
        });
        break;
      }
    }
  }
  private async chooseInstallOptions(context: PanelContext, item: PackageItem, installed: PackageItem | undefined): Promise<{ ref: string } | undefined> {
    const scope = this.scope(context), client = this.client(scope);
    type RefPick = vscode.QuickPickItem & { ref?: string; manual?: boolean };
    const quickPick = vscode.window.createQuickPick<RefPick>();
    quickPick.title = `Install ${item.name}: version or ref`;
    quickPick.placeholder = 'Select a tag or branch, or type a ref';
    quickPick.matchOnDescription = true;
    const fixed: RefPick[] = [
      { label: '$(package) Default', description: item.marketplace ? 'Version pinned by the marketplace' : 'Default branch / latest', ref: '' },
      { label: '$(edit) Enter a ref…', description: 'Tag, branch, or commit SHA', manual: true }
    ];
    quickPick.items = fixed; quickPick.busy = true; quickPick.show();
    const controller = new AbortController();
    void client.execute(['view', versionSource(item, installed, this.state.marketplaces), 'versions', ...(scope.kind === 'global' ? ['--global'] : [])], { signal: controller.signal, timeoutMs: 60_000 })
      .then(result => {
        const refs = parseVersions(result.stdout);
        const tags = refs.filter(r => r.type === 'tag').sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
        const branches = refs.filter(r => r.type !== 'tag');
        const group = (label: string, list: typeof refs, icon: string): RefPick[] => list.length ? [{ label, kind: vscode.QuickPickItemKind.Separator },
          ...list.map(ref => ({ label: `$(${icon}) ${ref.name}`, description: ref.commit, ref: ref.name }))] : [];
        quickPick.items = [...fixed, ...group('Tags', tags, 'tag'), ...group('Branches', branches, 'git-branch')];
      }).catch(error => {
        if (!controller.signal.aborted) this.output.appendLine(`Could not list versions: ${redact(String(error))}`);
        quickPick.items = [...fixed, { label: 'Versions could not be listed. See APM Output.', kind: vscode.QuickPickItemKind.Separator }];
      })
      .finally(() => { quickPick.busy = false; });
    const picked = await new Promise<RefPick | undefined>(resolve => {
      quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0] ?? (quickPick.value ? { label: quickPick.value, ref: quickPick.value } : undefined)));
      quickPick.onDidHide(() => resolve(undefined));
    });
    controller.abort(); quickPick.dispose();
    if (!picked) return undefined;
    let ref = picked.ref ?? '';
    if (picked.manual) {
      const typed = await vscode.window.showInputBox({ title: `Install ${item.name}: ref`, prompt: 'Git tag, branch, or commit SHA', validateInput: value => { try { withRef('x', value); return undefined; } catch (error) { return (error as Error).message; } } });
      if (typed === undefined) return undefined;
      ref = typed.trim();
    }
    return { ref };
  }
  private askVariable(prompt: VariablePrompt): Promise<string | undefined> {
    return Promise.resolve(vscode.window.showInputBox({
      title: `APM needs ${prompt.name}`,
      prompt: `${prompt.description || 'Required by an MCP server in this package.'} Values are hidden for privacy. APM uses this value to configure the MCP server for your selected tools. Press Escape to skip it; the install will then stop.`,
      placeHolder: prompt.name, password: prompt.secret, ignoreFocusOut: true
    }));
  }
  private async runPackageCommand(context: PanelContext, action: PackageAction, title: string, id: string, args: Record<string, string>, options: Record<string, unknown>,
    mutating: boolean, interpret?: (stdout: string) => Partial<ActionResult>) {
    const descriptor = descriptors.find(c => c.id === id);
    if (!descriptor) throw new Error(`Unknown APM command ${id}.`);
    const scope = this.scope(context), client = this.client(scope);
    const preview = options['--dry-run'] === true;
    context.retry = async () => {
      this.requireTrust();
      if (context.controller) throw new Error('Wait for the current package action or cancel it before retrying.');
      context.scope = scope;
      context.controller = new AbortController();
      try { await this.runPackageCommand(context, action, title, id, { ...args }, { ...options }, mutating, interpret); }
      finally { context.controller = undefined; }
    };
    let argv = buildCommandArguments(descriptor, args, options);
    const flags = Object.keys(options);
    if (!await client.supports(descriptor.command, flags)) throw new Error(`This APM CLI does not support ${descriptor.label} with ${flags.join(' ') || 'these arguments'}. Upgrade APM.`);
    if (mutating) {
      const confirmation = await vscode.window.showWarningMessage(
        `${title}? Scope: ${scope.label}. Host: ${this.hostLabel()}. APM may write manifests and deployed files, or execute package scripts. Only proceed for sources you trust.`,
        action === 'uninstall' ? 'Uninstall' : action === 'update' ? 'Update' : 'Install');
      if (!confirmation) return;
      if (descriptor.options.some(o => o.name === '--yes') && await client.supports(descriptor.command, ['--yes'])) argv = buildCommandArguments(descriptor, args, { ...options, '--yes': true });
    }
    const controller = context.controller ?? new AbortController();
    const command = `apm ${redact(argv.join(' '))}`;
    if (preview) {
      const applyOptions = { ...options };
      delete applyOptions['--dry-run'];
      context.preview = { id, args: { ...args }, options: applyOptions, title: `Apply preview for ${context.item?.name ?? title}`,
        action: action === 'previewUpdate' ? 'update' : 'install' };
    }
    context.extra.actionResult = { action, title, status: 'running', command, preview };
    context.extra.error = undefined;
    context.authenticationRepository = undefined;
    this.send(context);
    const execute = async () => {
      this.requireTrust();
      this.output.appendLine(`\n$ ${command}  (${scope.label})`);
      try {
        const ticket = id === 'audit' && options['--format'] === 'json' ? this.diagnostics.begin(scope.path) : undefined;
        const result = await vscode.window.withProgress({ location: context.webview ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, cancellation) => {
          const subscription = cancellation.onCancellationRequested(() => controller.abort());
          try { return await client.execute(argv, { signal: controller.signal, timeoutMs: mutating ? 30 * 60_000 : 5 * 60_000, onPrompt: mutating ? prompt => this.askVariable(prompt) : undefined }); }
          finally { subscription.dispose(); }
        });
        const output = redact([result.stdout, result.stderr].filter(text => text.trim()).join('\n'));
        const base: ActionResult = { action, title, command, preview, status: result.exitCode === 0 ? 'success' : 'failed', output: tail(output),
          summary: result.exitCode === 0 ? preview ? 'Preview only. No package changes applied. Resolution may change before the real run; offline plans can be incomplete.' : 'Completed successfully.' : `APM exited with code ${result.exitCode}.` };
        context.extra.actionResult = { ...base, ...(interpret ? interpret(result.stdout) : {}) };
        if (context.extra.actionResult.audit) {
          await this.publishAudit(context, scope, context.extra.actionResult.audit, ticket);
          if (context.extra.actionResult.audit.stale) {
            context.extra.actionResult.status = 'failed';
            context.extra.actionResult.summary = 'Files changed or a newer audit started during this scan. Run the audit again.';
          }
        }
        if (result.exitCode !== 0 && !context.extra.actionResult.audit) context.extra.error = redact(result.stderr || `APM exited with code ${result.exitCode}. Review the output.`);
      } catch (error) {
        if (error instanceof RepositoryAccessError) context.authenticationRepository = error.repository;
        context.extra.actionResult = { action, title, command, status: controller.signal.aborted ? 'cancelled' : 'failed',
          summary: redact(error instanceof Error ? error.message : String(error)) };
      } finally {
        this.send(context);
        if (context.extra.actionResult?.status === 'failed') this.report(new Error(context.extra.error || context.extra.actionResult.summary || `${title} failed. Review APM Output.`), context);
      }
    };
    if (!mutating) { await execute(); return; }
    await this.serialize('apm-mutations', execute);
    this.diagnostics.clear();
    if (context.extra.actionResult?.status === 'cancelled') return;
    const previousRequest = context.detailsRequest;
    if (this.refreshing) await this.refreshing;
    this.updateSnapshots.delete(scopeKey(scope));
    await this.refresh();
    if (context.extra.actionResult) {
      const result = verifyPackageUpdate(context.extra.actionResult, context.item, this.state.error ?? context.refreshError);
      context.extra.actionResult = result;
      if (action === 'update' && result.status === 'failed' && result.summary && !context.extra.error) this.report(new Error(result.summary), context);
      else this.send(context);
    }
    if (context.detailsRequest === previousRequest) await this.loadDetails(context);
  }
  private async publishAudit(context: PanelContext, scope: Scope, audit: NonNullable<ActionResult['audit']>, ticket?: AuditTicket) {
    const links = await this.diagnostics.publish(scope, audit, scope.path, ticket);
    context.navigation = new Map([...(context.navigation ?? []), ...links]);
  }
  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let resolve!: () => void;
    const current = new Promise<void>(r => { resolve = r; });
    this.queues.set(key, current);
    await previous;
    try { return await operation(); } finally { resolve(); if (this.queues.get(key) === current) this.queues.delete(key); }
  }
  private async runCommand(message: CommandRequest, context: PanelContext, inputLines?: readonly string[]) {
    this.requireTrust();
    if (this.commandTasks.has(context)) throw new Error('An APM task is already running on this page. Stop it before running another command.');
    if (context.controller) throw new Error('Another command is already running on this page.');
    const descriptor = descriptors.find(c => c.id === message.id);
    if (!descriptor) throw new Error('Unknown APM command.');
    const scope = { ...this.scope(context) }, client = this.client(scope);
    context.scope = scope;
    context.retry = () => {
      context.scope = scope;
      return this.runCommand({ ...message, args: { ...message.args }, options: { ...message.options } }, context, inputLines);
    };
    const options = { ...message.options };
    if ([...Object.values(message.args), ...Object.values(options)].some(value => typeof value === 'string' && containsUrlCredentials(value))) {
      throw new Error('Do not put credentials in URLs. Remove them and use APM authentication.');
    }
    const secretFields = Object.keys(message.args).concat(Object.keys(options)).some(k => /token|password|secret|credential|(?:api|access|private)[_-]?key/i.test(k));
    if (secretFields) throw new Error('Supply secrets through APM authentication in a terminal, not command fields or arguments.');
    if (scope.kind === 'workspace' && options['--global'] === true) throw new Error('Select Global in the scope selector instead of overriding --global.');
    if (scope.kind === 'global' && descriptor.global) options['--global'] = true;
    if (scope.kind === 'global' && !descriptor.global && ['init', 'install', 'uninstall', 'update', 'outdated', 'view', 'deps', 'prune', 'compile', 'run', 'pack', 'unpack', 'publish', 'plugin', 'lifecycle', 'list', 'preview', 'targets', 'lock', 'audit', 'policy'].includes(descriptor.command[0])) {
      throw new Error('This command does not support global scope. Select a workspace folder.');
    }
    if (scope.kind === 'global' && descriptor.command[0] === 'marketplace' && ['init', 'migrate', 'check', 'outdated', 'package'].includes(descriptor.command[1])) {
      throw new Error('Marketplace authoring requires an explicitly selected workspace folder.');
    }
    let args = buildCommandArguments(descriptor, message.args, options);
    const flags = descriptor.options.flatMap(o => options[o.name] === false && o.negative ? [o.negative] :
      options[o.name] !== undefined && options[o.name] !== '' && options[o.name] !== false ? [o.name] : []);
    if (!await client.supports(descriptor.command, flags)) throw new Error(`This APM CLI does not support ${descriptor.label} with the selected flags. Upgrade the CLI or change the options.`);
    const mutating = descriptor.mutates && !options['--dry-run'] && !options['--validate'] &&
      (descriptor.id !== 'audit' || options['--strip'] === true || typeof options['--output'] === 'string');
    if (mutating) {
      const trustMutation = descriptor.command[0] === 'approve' || descriptor.command[0] === 'deny';
      const trustDestination = options['--user'] === true ? 'your personal APM configuration' : `the shared apm.yml in ${scope.label}`;
      const trustAction = descriptor.command[0] === 'approve' ? 'Approve executable primitives for' : 'Deny executable primitives for';
      const lifecycleExecution = descriptor.id === 'lifecycle test' && options['--execute'] === true;
      const lifecycleReplacement = descriptor.id === 'lifecycle init' && options['--force'] === true;
      const lifecycleTrustChange = descriptor.id === 'lifecycle trust' || descriptor.id === 'lifecycle untrust';
      const confirmation = await vscode.window.showWarningMessage(
        trustMutation
          ? `${trustAction} ${message.args.packages} in ${trustDestination}? Host: ${this.hostLabel()}. This changes executable trust for the selected package. Only proceed for sources you trust.`
          : lifecycleExecution
            ? `Execute the "${message.args.event}" lifecycle scripts in ${scope.label}? Host: ${this.hostLabel()}. This runs project-defined commands and may change files or make network requests. Only proceed for projects you trust.`
            : lifecycleReplacement
              ? `Overwrite the existing lifecycle block in apm.yml in ${scope.label}? Host: ${this.hostLabel()}. This replaces the project's lifecycle definition. Only proceed for projects you trust.`
              : lifecycleTrustChange
                ? `${descriptor.id === 'lifecycle trust' ? 'Trust' : 'Revoke trust for'} lifecycle scripts from apm.yml in ${scope.label}? Host: ${this.hostLabel()}. ${descriptor.id === 'lifecycle trust' ? 'This allows' : 'This prevents'} APM from running these project-defined commands during future installs.`
                : descriptor.id === 'lifecycle init'
                  ? `Add a starter lifecycle block to apm.yml in ${scope.label}? Host: ${this.hostLabel()}. Edit and validate the scripts before trusting them.`
              : `${descriptor.label} in ${scope.label}? Host: ${this.hostLabel()}. ${options['--force'] === true ? 'WARNING: force can overwrite authored files and bypass critical security findings. ' : ''}${descriptor.id === 'init' && inputLines ? `Name: ${inputLines[0]}\nVersion: ${inputLines[1] || 'APM default'}\nDescription: ${inputLines[2] || 'APM default'}\nAuthor: ${inputLines[3] || 'APM default'}\nTargets: ${String(options['--target'] ?? 'APM auto-detection')}` : 'APM may write manifests or deployed files. Preview compilation first to inspect planned changes.'}\nOnly proceed for projects you trust.`,
        trustMutation ? 'Apply Trust Decision' : 'Run');
      if (!confirmation) return;
    }
    if (!inputLines && !requiresTerminal(descriptor, options) && descriptor.options.some(o => o.name === '--yes') && options['--yes'] === undefined && await client.supports(descriptor.command, ['--yes'])) {
      options['--yes'] = true; args = buildCommandArguments(descriptor, message.args, options);
    }
    const interactive = !inputLines && requiresTerminal(descriptor, options);
    if (interactive) {
      this.requireTrust();
      const executable = vscode.workspace.getConfiguration('apm', scope.kind === 'workspace' ? vscode.Uri.file(scope.path) : undefined).get<string>('executablePath', 'apm');
      const taskScope = scope.kind === 'workspace' ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(scope.path)) ?? vscode.TaskScope.Workspace : vscode.TaskScope.Global;
      const env = await this.commandEnvironment(args, scope.kind === 'global' ? homedir() : scope.path);
      this.requireTrust();
      if (this.commandTasks.has(context)) throw new Error('An APM task is already running on this page. Stop it before running another command.');
      const task = new vscode.Task({ type: 'apm-command', command: descriptor.id }, taskScope, descriptor.label, 'APM',
        new vscode.ProcessExecution(executable, args, { cwd: scope.kind === 'global' ? homedir() : scope.path, env }), []);
      task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
      const active: { execution?: vscode.TaskExecution; cancelled: boolean } = { cancelled: false };
      this.commandTasks.set(context, active);
      const pending: [vscode.TaskExecution, number | undefined][] = [];
      const finish = (execution: vscode.TaskExecution, exitCode: number | undefined) => {
        if (!active.execution) { pending.push([execution, exitCode]); return; }
        if (execution !== active.execution || this.commandTasks.get(context) !== active) return;
        this.commandTasks.delete(context);
        processListener.dispose(); endListener.dispose();
        context.extra.busy = false; context.extra.taskRunning = false;
        context.extra.result = active.cancelled ? 'APM task cancelled. Partial changes may remain. See its terminal for output.' :
          exitCode === undefined ? 'APM task ended without an exit code. Review the terminal; partial changes may remain.' :
            `APM task finished with exit code ${exitCode}. See its terminal for output.`;
        if (!active.cancelled && exitCode !== 0) context.extra.error = 'APM task did not complete successfully. Review its terminal.';
        this.send(context); this.scheduleRefresh();
      };
      const processListener = vscode.tasks.onDidEndTaskProcess(event => finish(event.execution, event.exitCode));
      const endListener = vscode.tasks.onDidEndTask(event => finish(event.execution, undefined));
      this.subscriptions.push(processListener, endListener);
      context.extra.busy = true; context.extra.taskRunning = true;
      context.extra.result = 'APM task started. Review its terminal output. Use Cancel or Tasks: Terminate Task to stop it.';
      this.send(context);
      try {
        active.execution = await vscode.tasks.executeTask(task);
        if (active.cancelled) active.execution.terminate();
        for (const [execution, exitCode] of pending) finish(execution, exitCode);
      } catch (error) {
        this.commandTasks.delete(context);
        processListener.dispose(); endListener.dispose();
        context.extra.busy = false; context.extra.taskRunning = false;
        context.extra.result = undefined;
        this.send(context);
        throw error;
      }
      return;
    }
    if (context.controller) throw new Error('Another command is already running on this page.');
    const controller = context.controller = new AbortController();
    try {
      const execute = async () => {
        this.requireTrust();
        if (descriptor.id === 'init' && inputLines && await hasProjectManifest(scope.path)) throw new Error('apm.yml was created while initialization was being configured. Open it instead of overwriting it.');
        this.operation = controller;
        context.extra.busy = true; context.extra.result = undefined; this.send(context);
        try {
          const ticket = descriptor.id === 'audit' && options['--format'] === 'json' ? this.diagnostics.begin(scope.path) : undefined;
          this.output.appendLine(`\n$ apm ${redact(args.join(' '))} (${scope.label})`);
          const result = await vscode.window.withProgress({ location: context.webview ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title: descriptor.label, cancellable: true }, async (_progress, cancellation) => {
            const subscription = cancellation.onCancellationRequested(() => controller.abort());
            try { return await client.execute(args, { signal: controller.signal, timeoutMs: 30 * 60_000,
              ...(inputLines ? { inputLines } : { onPrompt: (prompt: VariablePrompt) => this.askVariable(prompt) }) }); }
            finally { subscription.dispose(); }
          });
          context.extra.result = redact(`Exit code: ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
          if (descriptor.id === 'audit' && options['--format'] === 'json') {
            const audit = parseAudit(result.stdout);
            if (!audit) throw new Error('Unrecognized APM JSON audit report. Review APM Output.');
            await this.publishAudit(context, scope, audit, ticket);
            context.extra.actionResult = { action: 'audit', title: 'Workspace audit', command: `apm ${redact(args.join(' '))}`,
              status: audit.passed ? 'success' : 'failed', audit, summary: audit.stale ? 'Files changed or a newer audit started. Run the audit again.' : audit.coverage?.complete === false ? 'Audit coverage is incomplete.' : `${audit.findings.length} findings.` };
          }
          if (result.exitCode !== 0) context.extra.error = `APM exited with code ${result.exitCode}. Review the result; diagnostic commands can report findings through a nonzero exit status.`;
        } finally {
          this.operation = undefined; context.extra.busy = false; this.send(context);
        }
      };
      if (mutating) await this.serialize('apm-mutations', execute);
      else await execute();
    } finally {
      context.controller = undefined;
      if (mutating) {
        if (descriptor.id !== 'audit') this.diagnostics.clear();
        if (['install', 'update', 'uninstall'].includes(descriptor.command[0])) {
          if (this.refreshing) await this.refreshing;
          this.updateSnapshots.delete(scopeKey(scope));
        }
        await this.refresh();
      }
    }
  }
  async setup() {
    this.requireTrust();
    const os = platform(), host = vscode.env.remoteName ?? 'this computer';
    const upgrade = !!this.state.version;
    const verb = upgrade ? 'Upgrade' : 'Install';
    const executable = vscode.workspace.getConfiguration('apm').get<string>('executablePath', 'apm');
    const installation = upgrade ? await detectInstallation(executable) : { method: 'unknown' as InstallMethod, writable: false };
    type Choice = vscode.QuickPickItem & { method?: InstallMethod; command?: string[]; guide?: boolean };
    const python = os === 'win32' ? 'python' : 'python3';
    const options: Choice[] = [
      ...(upgrade ? [{ method: 'standalone' as const, label: `${verb} with apm self-update`,
        command: selfUpdateCommand(executable, installation, os) }] : []),
      os === 'win32' ? { method: 'winget', label: `${verb} with WinGet`, command: ['winget', upgrade ? 'upgrade' : 'install', '--id', 'Microsoft.APM', '--exact', '--source', 'winget'] }
        : { method: 'homebrew', label: `${verb} with Homebrew`, command: ['brew', upgrade ? 'upgrade' : 'install', 'apm'] },
      ...(upgrade ? [{ method: 'pipx' as const, label: `${verb} with pipx`, command: ['pipx', 'upgrade', 'apm-cli'] }] : []),
      { method: 'pip', label: `${verb} with Python pip`, command: [python, '-m', 'pip', 'install', ...(upgrade ? ['--upgrade'] : []), 'apm-cli'] }
    ];
    const how: Record<InstallMethod, string> = { homebrew: 'Homebrew', winget: 'WinGet', pipx: 'pipx', pip: 'Python pip', standalone: 'the APM installer', unknown: '' };
    const recommended = options.find(o => o.method === installation.method);
    const others = options.filter(o => o !== recommended && (!upgrade || installation.method === 'unknown' || o.method !== 'pipx'));
    const items: Choice[] = [
      ...(recommended ? [{ ...recommended, description: 'Recommended', detail: `APM was installed with ${how[installation.method]}${installation.path ? ` (${installation.path})` : ''}.` }] : []),
      ...(recommended && others.length ? [{ label: 'Other options', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...others,
      { label: 'Show installation guide', guide: true }
    ];
    const choice = await vscode.window.showQuickPick(items, {
      title: `${verb} APM on ${host}`,
      placeHolder: recommended ? `Recommended: ${recommended.label}` : upgrade ? 'Choose the tool you used to install APM' : 'Choose a package manager that is installed on this computer'
    });
    if (!choice) return;
    if (choice.guide || !choice.command) { await vscode.env.openExternal(vscode.Uri.parse('https://microsoft.github.io/apm/getting-started/installation/')); return; }
    const command = choice.command;
    const selfUpdate = choice.method === 'standalone';
    const detail = selfUpdate
      ? `Downloads and installs the latest APM release.${command[0] === 'sudo' ? ` APM is installed in ${installation.path ? dirname(installation.path) : 'a folder'} owned by an administrator account, so the update runs with sudo. Enter your password in the terminal when asked.` : ''}`
      : `Runs in a terminal on ${host}.${choice.method === 'pip' ? ' Requires Python 3.10 or later.' : ''}${recommended && choice !== recommended ? ` APM appears to be installed with ${how[installation.method]}; using another tool can leave two copies.` : ''}`;
    const shown = command[0] === 'sudo' ? 'sudo apm self-update' : command.join(' ');
    const confirm = await vscode.window.showInformationMessage(`${verb} APM with "${shown}"? ${detail}`, verb);
    if (!confirm) return;
    const task = new vscode.Task({ type: 'apm-install' }, vscode.TaskScope.Global, choice.label, 'APM', new vscode.ProcessExecution(command[0], command.slice(1)), []);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: true, panel: vscode.TaskPanelKind.Dedicated };
    const execution = await vscode.tasks.executeTask(task);
    const listener = vscode.tasks.onDidEndTaskProcess(event => {
      if (event.execution !== execution) return;
      listener.dispose();
      if (event.exitCode === 0) {
        const previous = this.state.version;
        this.epoch++; this.state.version = undefined; this.state.warning = undefined;
        void this.refresh().then(() => {
          const current = this.state.version;
          if (!current) return;
          if (upgrade && current === previous) {
            this.report(new Error(`The ${verb.toLowerCase()} finished, but the APM that VS Code runs (${installation.path ?? executable}) is still ${current}. Check the terminal output, or set apm.executablePath to the new APM.`));
          } else void vscode.window.showInformationMessage(`APM ${current} is ready.`);
        });
      } else this.report(new Error(`APM ${verb.toLowerCase()} exited with code ${event.exitCode}. Review the terminal.`));
    });
    this.subscriptions.push(listener);
  }
}

function openSettings(query: string) {
  return vscode.commands.executeCommand('workbench.action.openSettings', query);
}

export function activate(context: vscode.ExtensionContext) {
  const extension = new ApmExtension(context);
  context.subscriptions.push(extension, vscode.window.registerWebviewViewProvider('apm.browser', {
    resolveWebviewView: view => extension.resolveWebviewView(view)
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  for (const [command, callback] of [
    ...Object.keys(workflowCommands).filter(workflow => workflow !== 'previewInstall' && workflow !== 'policy').map(workflow => [`apm.${workflow}`, (uri?: unknown) => extension.workflow(workflow as Workflow, uri instanceof vscode.Uri ? uri : undefined)] as const),
    ['apm.targets', (uri?: unknown) => extension.showTargets(undefined, uri instanceof vscode.Uri ? uri : undefined)],
    ['apm.dependencies.refresh', () => extension.refreshDependencyTree()],
    ['apm.dependencies.why', (item?: unknown) => extension.explainDependency(item)],
    ['apm.dependencies.find', (uri?: unknown) => extension.findDependencyFile(uri)],
    ['apm.actions', () => extension.moreActions()],
    ['apm.policy.review', () => extension.reviewExecutableTrust()],
    ['apm.policy.explain', () => extension.workflow('policy')],
    ['apm.policy.manage', () => extension.manageExecutableTrust()],
    ['apm.marketplace.health', () => extension.marketplaceHealth()],
    ['apm.mcp.discover', () => extension.discoverMcpServers()],
    ['apm.mcp.install', () => extension.installMcpServer()],
    ['apm.lifecycle', () => extension.lifecycleWorkflows()],
    ['apm.reports.dependencies', () => extension.dependencyReports()],
    ['apm.refresh', () => extension.refreshAll()],
    ['apm.marketplaces', () => openSettings('apm.marketplaces')],
    ['apm.settings', () => openSettings(`@ext:${context.extension.id}`)],
    ...(['catalog', 'installed', 'updates'] as const).map(section => [`apm.views.${section}`, () => extension.toggleSection(section)] as const),
    ['apm.signIn', () => extension.signIn()],
    ['apm.manageAccounts', () => extension.manageAccounts()],
    ['apm.install', () => extension.installPackage()],
    ['apm.setup', () => extension.setup()],
    ['apm.filter.installed', () => extension.toggleStatus('@installed')],
    ['apm.filter.updates', () => extension.toggleStatus('@updates')],
    ['apm.filter.dependencies', () => extension.toggleStatus('@dependencies')],
    ['apm.filter.scope.all', () => extension.chooseScope('')],
    ['apm.filter.scope.workspace', () => extension.chooseScope('workspace')],
    ['apm.filter.scope.global', () => extension.chooseScope('global')],
    ['apm.filter.marketplace.all', () => extension.chooseMarketplace(true)],
    ['apm.filter.marketplace.choose', () => extension.chooseMarketplace()],
    ...(['name', 'name-desc', 'marketplace'] as const).map(order => [`apm.filter.sort.${order}`, () => extension.sortBy(order)] as const),
    ['apm.output', () => extension.showOutput()]
  ] as const) {
    const handler = async (argument?: unknown) => {
      try { await callback(argument); }
      catch (error) { extension.report(error); }
    };
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
    if (command.startsWith('apm.views.') || command.startsWith('apm.filter.')) {
      context.subscriptions.push(vscode.commands.registerCommand(`${command}.checked`, handler));
    }
  }
}
