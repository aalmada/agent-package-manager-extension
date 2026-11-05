import * as vscode from 'vscode';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { ApmClient } from './apm/client';
import type { VariablePrompt } from './apm/adapters';
import { descriptors, buildCommandArguments, requiresTerminal } from './apm/commands';
import type { PackageItem, Scope } from './apm/types';
import type { Message, Mode, State } from './protocol';
import { parseMessage, scopeKey } from './protocol';
import { SettingsSync } from './config/sync';
import { webviewHtml } from './views/html';
import { filterTokens, withStatus, withToken, type Ordering } from './webview/filter';
import { renderMarkdown } from './views/markdown';
import { containsUrlCredentials, redact, safePayload } from './apm/redact';
import { detectInstallation, selfUpdateCommand, type InstallMethod } from './apm/installation';
import { packageIdentity, parseAudit, parseTargets, parseVersions, tail, versionSource, withRef, type ActionResult, type PackageAction } from './apm/actions';
import { applyUpdateRows, findInstalledPackage, reconcileDetailContexts, retainUpdateResults } from './apm/packageState';

interface PanelContext {
  webview: vscode.Webview;
  mode: Mode;
  panel?: vscode.WebviewPanel;
  scope?: Scope;
  item?: PackageItem;
  controller?: AbortController;
  detailsController?: AbortController;
  detailsRequest?: number;
  refreshError?: string;
  extra: Partial<State>;
}

class ApmExtension implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('APM');
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly panels = new Map<string, PanelContext>();
  private sidebar?: PanelContext;
  private search = '';
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private operation?: AbortController;
  private refreshController?: AbortController;
  private queues = new Map<string, Promise<void>>();
  private epoch = 0;
  private readonly settingsSync: SettingsSync;
  private state: State = {
    mode: 'browser', trusted: vscode.workspace.isTrusted, scopes: [], scopeKey: '', busy: false,
    catalog: [], installed: [], marketplaces: [], commands: descriptors, availableCommands: [], errors: []
  };
  constructor(private readonly context: vscode.ExtensionContext) {
    this.rebuildScopes();
    this.settingsSync = new SettingsSync(
      context.globalState, () => this.client(this.globalScope()), text => this.output.append(redact(text)),
      message => this.report(new Error(message)), operation => this.serialize('apm-mutations', operation)
    );
    this.subscriptions.push(this.output);
    this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { this.rebuildScopes(); this.scheduleRefresh(); }));
    this.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.settingsSync.sync(); this.scheduleRefresh(); }));
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('apm.executablePath')) { this.epoch++; this.state.version = undefined; this.scheduleRefresh(); }
      if (event.affectsConfiguration('apm.allowRemoteImages')) {
        for (const entry of this.panels.values()) {
          if (entry.mode !== 'details') continue;
          if (typeof entry.extra.details?.readme === 'string') this.setReadme(entry, entry.extra.details.readme);
          entry.webview.html = webviewHtml(entry.webview, this.context.extensionUri, this.allowRemoteImages());
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
    const registry = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(join(homedir(), '.apm')), 'marketplaces.json'));
    this.subscriptions.push(registry, registry.onDidChange(() => this.scheduleRefresh()), registry.onDidCreate(() => this.scheduleRefresh()), registry.onDidDelete(() => this.scheduleRefresh()));
    const cliConfig = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(join(homedir(), '.apm')), 'config.json'));
    const syncConfig = () => void this.settingsSync.sync();
    this.subscriptions.push(cliConfig, cliConfig.onDidChange(syncConfig), cliConfig.onDidCreate(syncConfig), cliConfig.onDidDelete(syncConfig));
    void this.settingsSync.sync();
    this.updateFilterContext();
  }
  dispose() {
    this.operation?.abort();
    this.refreshController?.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const disposable of this.subscriptions) disposable.dispose();
    for (const entry of this.panels.values()) entry.panel?.dispose();
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
      onOutput: text => this.output.append(redact(text))
    });
  }
  private requireTrust() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running APM or reading package sources.');
  }
  private allowRemoteImages() {
    return vscode.workspace.getConfiguration('apm').get<boolean>('allowRemoteImages', false);
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.sidebar = this.attach(view.webview, 'browser');
    this.subscriptions.push(view.onDidChangeVisibility(() => { if (view.visible) void this.refresh(); }));
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
    const state: State = {
      ...this.state, ...context.extra, mode: context.mode, trusted: vscode.workspace.isTrusted,
      errors: context.refreshError ? [...this.state.errors, context.refreshError] : this.state.errors,
      ...(context.scope ? { scopeKey: scopeKey(context.scope) } : {}), ...(context.item ? { item: context.item } : {})
    };
    void context.webview.postMessage({ type: 'state', state: safePayload(state) });
  }
  private broadcast() {
    if (this.sidebar) this.send(this.sidebar);
    for (const panel of this.panels.values()) this.send(panel);
  }
  private report(error: unknown, context?: PanelContext) {
    const message = redact(error instanceof Error ? error.message : String(error));
    this.output.appendLine(`\nERROR: ${message}`);
    if (context) { context.extra.error = message; this.send(context); } else { this.state.error = message; this.broadcast(); }
    void vscode.window.showErrorMessage(message, 'Show Output').then(choice => { if (choice) this.output.show(); });
  }
  private scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { if (this.refreshing) this.refreshAgain = true; else void this.refresh(); }, 400);
  }
  /** Explicit user refresh: also retries marketplace entries that previously failed to register. */
  async refreshAll() {
    this.settingsSync.retry();
    if (this.refreshing) await this.refreshing;
    const requests = new Map([...this.panels.values()].filter(entry => entry.mode === 'details').map(entry => [entry, entry.detailsRequest]));
    await this.refresh();
    if (this.state.error) return;
    await Promise.all([...requests].filter(([entry, request]) => entry.detailsRequest === request && entry.item && entry.panel)
      .map(([entry]) => this.loadDetails(entry)));
  }
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().catch(error => this.report(error)).finally(() => {
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
    const previousInstalled = this.state.installed;
    this.state.busy = true; this.state.error = undefined; this.state.errors = []; this.broadcast();
    try {
      const probe = await client.probe();
      if (epoch !== this.epoch) return;
      this.state.version = probe.version; this.state.warning = probe.warning; this.state.availableCommands = probe.commands;
      await this.settingsSync.sync();
      if (epoch !== this.epoch) return;
      const registered = await client.getMarketplaces();
      if (epoch !== this.epoch) return;
      this.state.marketplaces = registered;
      const [catalog, installed] = await Promise.allSettled([client.getCatalog(registered), client.getInstalled(scope)]);
      if (epoch !== this.epoch) return;
      if (catalog.status === 'fulfilled') {
        const failed = registered.filter(m => !catalog.value.items.some(i => i.marketplace === m.name) && catalog.value.errors.some(error => error.startsWith(`${m.name}:`))).map(m => m.name);
        this.state.catalog = [...catalog.value.items, ...this.state.catalog.filter(i => failed.includes(i.marketplace)).map(i => ({ ...i, metadata: { ...i.metadata, stale: true } }))];
        this.state.errors.push(...catalog.value.errors);
      } else this.state.errors.push(`Catalog: ${redact(String(catalog.reason))}`);
      // `apm deps list` has no descriptions; borrow catalog ones so text filters match Installed and Updates too.
      if (installed.status === 'fulfilled') {
        this.state.installed = this.withDescriptions(installed.value);
        if (!installed.value.length) this.state.checkedAt = undefined;
        this.updateDetailItems(scope, this.state.installed);
      } else this.state.errors.push(`Installed: ${redact(String(installed.reason))}`);
      this.setDetailRefreshError(scope);
      this.broadcast();
      if (installed.status === 'fulfilled' && installed.value.length) {
        try {
          const updates = await client.checkUpdates(scope, this.state.installed);
          if (epoch !== this.epoch) return;
          this.state.installed = applyUpdateRows(this.state.installed, updates);
          this.state.checkedAt = new Date().toISOString();
        } catch (error) {
          if (epoch !== this.epoch) return;
          this.state.installed = retainUpdateResults(this.state.installed, previousInstalled);
          this.state.errors.push(`Updates: ${redact(String(error))}`);
        }
      }
      this.state.catalog = this.state.catalog.map(item => {
        const installedItem = findInstalledPackage(item, this.state.installed);
        return { ...item, installed: !!installedItem, updateStatus: installedItem?.updateStatus, latestVersion: installedItem?.latestVersion, updateStale: installedItem?.updateStale };
      });
      if (installed.status === 'fulfilled') this.updateDetailItems(scope, this.state.installed);
      await this.refreshOtherDetailScopes(scope, controller.signal, epoch);
    } catch (error) {
      if (epoch === this.epoch) throw error;
    } finally { this.refreshController = undefined; this.state.busy = false; this.broadcast(); }
  }
  private withDescriptions(items: PackageItem[]): PackageItem[] {
    return items.map(item => item.description ? item : { ...item, description: this.state.catalog.find(c => c.id === item.id)?.description });
  }
  private detailContexts(scope: Scope): PanelContext[] {
    return [...this.panels.values()].filter(entry => entry.mode === 'details' && entry.scope && scopeKey(entry.scope) === scopeKey(scope) && entry.item);
  }
  private setDetailRefreshError(scope: Scope, error?: string) {
    const entries = this.detailContexts(scope);
    if (error && entries.some(entry => entry.refreshError !== error)) this.output.appendLine(`\n${error}`);
    for (const entry of entries) entry.refreshError = error;
  }
  private updateDetailItems(scope: Scope, installed: PackageItem[]) {
    reconcileDetailContexts(this.panels.values(), scope, this.state.catalog, installed, entry => { void this.loadDetails(entry); });
    for (const entry of this.detailContexts(scope)) this.send(entry);
  }
  private async refreshOtherDetailScopes(selected: Scope, signal: AbortSignal, epoch: number) {
    const scopes = new Map<string, Scope>();
    for (const entry of this.panels.values()) {
      if (entry.mode === 'details' && entry.scope && entry.item && scopeKey(entry.scope) !== scopeKey(selected)) {
        scopes.set(scopeKey(entry.scope), entry.scope);
      }
    }
    await Promise.all([...scopes.values()].map(async scope => {
      const previous = this.detailContexts(scope).flatMap(entry => entry.item ? [entry.item] : []);
      const client = this.client(scope, signal);
      try {
        let installed = this.withDescriptions(await client.getInstalled(scope));
        if (epoch !== this.epoch || signal.aborted) return;
        this.setDetailRefreshError(scope);
        this.updateDetailItems(scope, installed);
        let warning: string | undefined;
        if (installed.length) {
          try {
            const updates = await client.checkUpdates(scope, installed);
            if (epoch !== this.epoch || signal.aborted) return;
            installed = applyUpdateRows(installed, updates);
          } catch (error) {
            if (epoch !== this.epoch || signal.aborted) return;
            installed = retainUpdateResults(installed, previous);
            warning = `Updates (${scope.label}): ${redact(String(error))}`;
          }
        }
        this.setDetailRefreshError(scope, warning);
        this.updateDetailItems(scope, installed);
      } catch (error) {
        if (epoch !== this.epoch || signal.aborted) return;
        this.setDetailRefreshError(scope, `Installed (${scope.label}): ${redact(String(error))}`);
      }
    }));
  }
  open(command?: string, args: Record<string, string> = {}, options: Record<string, unknown> = {}, scope?: Scope) {
    let entry = this.panels.get('tools');
    if (!entry) {
      const panel = vscode.window.createWebviewPanel('apm.tools', 'APM Tools', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      entry = this.attach(panel.webview, 'tools', panel);
      this.panels.set('tools', entry);
      panel.onDidDispose(() => this.panels.delete('tools'));
    }
    entry.scope = scope;
    if (command) entry.extra = { ...entry.extra, selectedCommand: command, commandRequest: (entry.extra.commandRequest ?? 0) + 1, commandArgs: args, commandOptions: options, error: undefined };
    entry.panel?.reveal();
    this.send(entry);
  }
  updateFilterContext() {
    const tokens = filterTokens(this.search);
    const keys: Record<string, unknown> = {
      'apm.filter.installed': tokens.installed, 'apm.filter.updates': tokens.updates, 'apm.filter.sort': tokens.sort,
      'apm.filter.marketplace': tokens.marketplace, 'apm.filter.scopeKind': this.scope()?.kind ?? ''
    };
    for (const [key, value] of Object.entries(keys)) void vscode.commands.executeCommand('setContext', key, value);
  }
  private setSearch(search: string) {
    this.search = search; this.updateFilterContext();
    if (this.sidebar) void this.sidebar.webview.postMessage({ type: 'setSearch', search });
  }
  toggleStatus(status: '@installed' | '@updates') {
    const tokens = filterTokens(this.search), on = status === '@installed' ? tokens.installed : tokens.updates;
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
  async chooseScope(kind: 'workspace' | 'global') {
    let target = kind === 'global' ? this.globalScope() : undefined;
    if (kind === 'workspace') {
      const folders = this.state.scopes.filter(s => s.kind === 'workspace');
      if (!folders.length) { void vscode.window.showInformationMessage('Open a workspace folder to manage workspace packages.'); return; }
      target = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(
        folders.map(f => ({ label: f.label, description: f.path, detail: scopeKey(f) === this.state.scopeKey ? 'Current scope' : undefined, scope: f })),
        { title: 'Select Workspace Folder', placeHolder: 'Show and install packages for this folder' }))?.scope;
    }
    if (target && scopeKey(target) !== this.state.scopeKey) await this.selectScope(scopeKey(target));
  }
  private async selectScope(key: string) {
    this.epoch++; this.refreshController?.abort(); if (this.refreshing) this.refreshAgain = true;
    this.state.scopeKey = key; this.state.catalog = []; this.state.installed = []; this.state.checkedAt = undefined;
    await this.context.workspaceState.update('scopeKey', key);
    this.updateFilterContext();
    await this.refresh();
  }
  async pickCommand() {
    const available = new Set(this.state.availableCommands);
    const items = descriptors
      .filter(d => !available.size || available.has(d.command[0]))
      .map(d => ({ label: d.label, description: `apm ${d.command.join(' ')}`, detail: d.description, id: d.id }));
    const picked = await vscode.window.showQuickPick(items, { title: 'Run APM Command', placeHolder: 'Select an APM command to configure and run', matchOnDescription: true, matchOnDetail: true });
    if (picked) this.open(picked.id);
  }
  private async openDetails(id: string) {
    this.requireTrust();
    const item = this.state.installed.find(i => i.id === id) ?? this.state.catalog.find(i => i.id === id);
    if (!item) throw new Error('Package is no longer available. Refresh and retry.');
    const scope = this.scope(), key = `details:${scopeKey(scope)}:${id}`;
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
  }
  private async handle(message: Message, context: PanelContext) {
    if (message.type !== 'ready' && message.type !== 'filters') context.extra.error = undefined;
    switch (message.type) {
      case 'ready': this.send(context); if (context.mode === 'browser' || !this.state.version) await this.refresh(); break;
      case 'refresh': await this.refreshAll(); break;
      case 'scope': {
        const scope = this.state.scopes.find(s => scopeKey(s) === message.key);
        if (!scope) throw new Error('Unknown APM scope.');
        if (context.mode === 'tools') context.scope = scope;
        await this.selectScope(message.key); break;
      }
      case 'filters': if (context.mode === 'browser') { this.search = message.search; this.updateFilterContext(); } break;
      case 'details': await this.openDetails(message.id); break;
      case 'tools': this.open(); break;
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
      case 'selectCommand': this.open(message.id, message.args, message.options, this.scope(context)); break;
      case 'command': await this.runCommand(message, context); break;
      case 'packageAction': await this.packageAction(message.action, context); break;
      case 'help': {
        this.requireTrust();
        const descriptor = descriptors.find(c => c.id === message.id);
        if (!descriptor) throw new Error('Unknown command.');
        const result = await this.client(this.scope(context)).execute([...descriptor.command, '--help']);
        context.extra.result = redact(result.stdout + result.stderr); this.send(context); break;
      }
      case 'cancel':
        if (context.mode === 'details') context.controller?.abort();
        else { this.operation?.abort(); this.refreshController?.abort(); }
        break;
    }
  }
  private async packageAction(action: PackageAction, context: PanelContext) {
    this.requireTrust();
    if (context.mode !== 'details' || !context.item) throw new Error('Open a package page to run package actions.');
    if (context.controller) throw new Error('Another action is already running on this page. Wait for it or cancel it.');
    const item = context.item, scope = this.scope(context);
    const installed = scopeKey(scope) === this.state.scopeKey
      ? findInstalledPackage(item, this.state.installed)
      : item.installed ? item : undefined;
    const global = scope.kind === 'global';
    context.controller = new AbortController();
    try { await this.dispatchPackageAction(action, context, item, installed, scope, global); }
    finally { context.controller = undefined; }
  }
  private async dispatchPackageAction(action: PackageAction, context: PanelContext, item: PackageItem, installed: PackageItem | undefined, scope: Scope, global: boolean) {
    switch (action) {
      case 'install': {
        await this.runPackageCommand(context, action, `Install ${item.name}`, 'install', { packages: packageIdentity(item, installed, true) }, global ? { '--global': true } : {}, true);
        break;
      }
      case 'installWithOptions': {
        const choice = await this.chooseInstallOptions(context, item, installed);
        if (!choice) return;
        await this.runPackageCommand(context, action, `Install ${item.name}${choice.ref ? ` #${choice.ref}` : ''}`, 'install',
          { packages: withRef(packageIdentity(item, installed, true), choice.ref) },
          { ...(global ? { '--global': true } : {}), ...(choice.targets.length ? { '--target': choice.targets.join(',') } : {}) }, true);
        break;
      }
      case 'uninstall':
        if (!installed) throw new Error(`${item.name} is not installed in ${scope.label}.`);
        await this.runPackageCommand(context, action, `Uninstall ${item.name}`, 'uninstall', { packages: packageIdentity(item, installed, false) }, global ? { '--global': true } : {}, true);
        break;
      case 'update':
        if (!installed) throw new Error(`${item.name} is not installed in ${scope.label}.`);
        await this.runPackageCommand(context, action, `Update ${item.name}`, 'update', { packages: packageIdentity(item, installed, false) }, global ? { '--global': true } : {}, true);
        break;
      case 'audit': {
        if (global) throw new Error('APM audit scans a project. Select a workspace folder.');
        if (!installed) throw new Error(`${item.name} is not installed in ${scope.label}.`);
        const json = await this.client(scope).supports(['audit'], ['--format']);
        await this.runPackageCommand(context, action, `Audit ${item.name}`, 'audit', { package: packageIdentity(item, installed, false) }, json ? { '--format': 'json' } : {}, false, stdout => {
          const audit = json ? parseAudit(stdout) : undefined;
          if (!audit) return {};
          const counts = Object.entries(audit.summary).filter(([key]) => key !== 'files_scanned' && key !== 'files_affected').map(([key, count]) => `${count} ${key}`).join(', ');
          return { audit, status: audit.passed ? 'success' : 'failed', summary: `${audit.passed ? 'Passed' : 'Findings reported'} — ${audit.summary.files_scanned ?? 0} files scanned${counts ? `; ${counts}` : ''}.` };
        });
        break;
      }
      case 'tree':
        await this.runPackageCommand(context, action, 'Dependency tree (whole scope)', 'deps tree', {}, global ? { '--global': true } : {}, false);
        break;
    }
  }
  private async chooseInstallOptions(context: PanelContext, item: PackageItem, installed: PackageItem | undefined): Promise<{ ref: string; targets: string[] } | undefined> {
    const scope = this.scope(context), client = this.client(scope);
    type RefPick = vscode.QuickPickItem & { ref?: string; manual?: boolean };
    const quickPick = vscode.window.createQuickPick<RefPick>();
    quickPick.title = `Install ${item.name}: version or ref (1/2)`;
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
      }).catch(() => { quickPick.items = [...fixed, { label: 'Versions could not be listed', kind: vscode.QuickPickItemKind.Separator }]; })
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
    let targets: string[] = [];
    try { targets = parseTargets((await client.execute(['install', '--help'], { timeoutMs: 30_000 })).stdout); } catch { /* fall back to free text */ }
    let selectedTargets: string[];
    if (targets.length) {
      const picks = await vscode.window.showQuickPick(targets.map(label => ({ label })), {
        title: `Install ${item.name}: targets (2/2)`, placeHolder: 'Select target harnesses, or none to use apm.yml / auto-detection', canPickMany: true
      });
      if (!picks) return undefined;
      selectedTargets = picks.map(p => p.label);
    } else {
      const typed = await vscode.window.showInputBox({ title: `Install ${item.name}: targets (2/2)`, prompt: 'Comma-separated targets; leave empty to use apm.yml / auto-detection' });
      if (typed === undefined) return undefined;
      selectedTargets = typed.split(',').map(t => t.trim()).filter(Boolean);
    }
    return { ref, targets: selectedTargets };
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
    let argv = buildCommandArguments(descriptor, args, options);
    const flags = Object.keys(options);
    if (!await client.supports(descriptor.command, flags)) throw new Error(`This APM CLI does not support ${descriptor.label} with ${flags.join(' ') || 'these arguments'}. Upgrade APM.`);
    if (mutating) {
      const confirmation = await vscode.window.showWarningMessage(`${title}?`, {
        modal: true,
        detail: `Scope: ${scope.label} (${scope.path})\n\napm ${redact(argv.join(' '))}\n\nAPM may write manifests and deployed files, or execute package scripts. Only proceed for sources you trust.`
      }, action === 'uninstall' ? 'Uninstall' : action === 'update' ? 'Update' : 'Install');
      if (!confirmation) return;
      if (descriptor.options.some(o => o.name === '--yes') && await client.supports(descriptor.command, ['--yes'])) argv = buildCommandArguments(descriptor, args, { ...options, '--yes': true });
    }
    const controller = context.controller ?? new AbortController();
    const command = `apm ${redact(argv.join(' '))}`;
    context.extra.actionResult = { action, title, status: 'running', command };
    this.send(context);
    const execute = async () => {
      this.requireTrust();
      this.output.appendLine(`\n$ ${command}  (${scope.label})`);
      try {
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, () =>
          client.execute(argv, { signal: controller.signal, timeoutMs: mutating ? 30 * 60_000 : 5 * 60_000, onPrompt: mutating ? prompt => this.askVariable(prompt) : undefined }));
        const output = redact([result.stdout, result.stderr].filter(text => text.trim()).join('\n'));
        const base: ActionResult = { action, title, command, status: result.exitCode === 0 ? 'success' : 'failed', output: tail(output),
          summary: result.exitCode === 0 ? 'Completed successfully.' : `APM exited with code ${result.exitCode}.` };
        context.extra.actionResult = { ...base, ...(interpret ? interpret(result.stdout) : {}) };
      } catch (error) {
        context.extra.actionResult = { action, title, command, status: controller.signal.aborted ? 'cancelled' : 'failed',
          summary: redact(error instanceof Error ? error.message : String(error)) };
      } finally { this.send(context); }
    };
    if (!mutating) { await execute(); return; }
    await this.serialize('apm-mutations', execute);
    if (context.extra.actionResult?.status === 'cancelled') return;
    const previousRequest = context.detailsRequest;
    if (this.refreshing) await this.refreshing;
    await this.refresh();
    if (context.detailsRequest === previousRequest) await this.loadDetails(context);
  }
  private async serialize(key: string, operation: () => Promise<void>) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let resolve!: () => void;
    const current = new Promise<void>(r => { resolve = r; });
    this.queues.set(key, current);
    await previous;
    try { await operation(); } finally { resolve(); if (this.queues.get(key) === current) this.queues.delete(key); }
  }
  private async runCommand(message: Extract<Message, { type: 'command' }>, context: PanelContext) {
    this.requireTrust();
    const descriptor = descriptors.find(c => c.id === message.id);
    if (!descriptor) throw new Error('Unknown APM command.');
    const scope = this.scope(context), client = this.client(scope);
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
    const display = `${descriptor.label}\nScope: ${scope.label} (${scope.path})\n${redact(JSON.stringify(args))}`;
    const confirmation = await vscode.window.showWarningMessage(display, { modal: true, detail: 'APM may write manifests, deployed files, caches, global settings, or execute package scripts. Only proceed for sources you trust.' }, 'Run');
    if (!confirmation) return;
    if (descriptor.options.some(o => o.name === '--yes') && options['--yes'] === undefined && await client.supports(descriptor.command, ['--yes'])) {
      options['--yes'] = true; args = buildCommandArguments(descriptor, message.args, options);
    }
    const interactive = requiresTerminal(descriptor, options);
    if (interactive) {
      const executable = vscode.workspace.getConfiguration('apm', scope.kind === 'workspace' ? vscode.Uri.file(scope.path) : undefined).get<string>('executablePath', 'apm');
      const taskScope = scope.kind === 'workspace' ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(scope.path)) ?? vscode.TaskScope.Workspace : vscode.TaskScope.Global;
      const task = new vscode.Task({ type: 'apm', command: descriptor.id }, taskScope, descriptor.label, 'APM',
        new vscode.ProcessExecution(executable, args, { cwd: scope.kind === 'global' ? homedir() : scope.path }), []);
      task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
      const execution = await vscode.tasks.executeTask(task);
      context.extra.busy = true;
      context.extra.result = 'Interactive APM task started. Review its terminal output. Use Tasks: Terminate Task to cancel.';
      const processListener = vscode.tasks.onDidEndTaskProcess(event => {
        if (event.execution !== execution) return;
        processListener.dispose(); endListener.dispose();
        context.extra.busy = false;
        context.extra.result = `Interactive APM task finished with exit code ${event.exitCode}. See its terminal for output.`;
        if (event.exitCode !== 0) context.extra.error = 'APM task did not complete successfully. Review its terminal.';
        this.send(context); this.scheduleRefresh();
      });
      const endListener = vscode.tasks.onDidEndTask(event => {
        if (event.execution !== execution) return;
        processListener.dispose(); endListener.dispose();
        if (context.extra.busy) {
          context.extra.busy = false; context.extra.error = 'APM task ended without an exit code. Review the terminal; partial changes may remain.';
          this.send(context); this.scheduleRefresh();
        }
      });
      this.subscriptions.push(processListener, endListener);
      this.send(context); return;
    }
    try {
      await this.serialize('apm-mutations', async () => {
        this.requireTrust();
        this.operation = new AbortController();
        context.extra.busy = true; context.extra.result = undefined; this.send(context);
        try {
          const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: descriptor.label, cancellable: true }, async (_progress, cancellation) => {
            const subscription = cancellation.onCancellationRequested(() => this.operation?.abort());
            try { return await client.execute(args, { signal: this.operation?.signal, timeoutMs: 30 * 60_000, onPrompt: prompt => this.askVariable(prompt) }); }
            finally { subscription.dispose(); }
          });
          context.extra.result = redact(`Exit code: ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
          if (result.exitCode !== 0) context.extra.error = `APM exited with code ${result.exitCode}. Review the result; diagnostic commands can report findings through a nonzero exit status.`;
        } finally {
          this.operation = undefined; context.extra.busy = false; this.send(context);
        }
      });
    } finally { await this.refresh(); }
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
    const confirm = await vscode.window.showInformationMessage(`${verb} APM with "${shown}"?`, { modal: true, detail }, verb);
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
  context.subscriptions.push(extension, vscode.window.registerWebviewViewProvider('apm.browser', extension, { webviewOptions: { retainContextWhenHidden: true } }));
  for (const [command, callback] of [
    ['apm.refresh', () => extension.refreshAll()],
    ['apm.tools', (id?: unknown) => typeof id === 'string' && descriptors.some(d => d.id === id) ? extension.open(id) : extension.pickCommand()],
    ['apm.marketplaces', () => openSettings('apm.marketplaces')],
    ['apm.settings', () => openSettings(`@ext:${context.extension.id}`)],
    ['apm.install', () => extension.open('install')],
    ['apm.setup', () => extension.setup()],
    ['apm.filter.installed', () => extension.toggleStatus('@installed')],
    ['apm.filter.updates', () => extension.toggleStatus('@updates')],
    ['apm.filter.scope.workspace', () => extension.chooseScope('workspace')],
    ['apm.filter.scope.global', () => extension.chooseScope('global')],
    ['apm.filter.marketplace.all', () => extension.chooseMarketplace(true)],
    ['apm.filter.marketplace.choose', () => extension.chooseMarketplace()],
    ...(['name', 'name-desc', 'marketplace', 'version', 'version-desc'] as const).map(order => [`apm.filter.sort.${order}`, () => extension.sortBy(order)] as const),
    ['apm.output', () => vscode.commands.executeCommand('workbench.action.output.toggleOutput')]
  ] as const) context.subscriptions.push(vscode.commands.registerCommand(command, callback));
}
