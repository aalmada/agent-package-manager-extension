import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import type { Message, PackageSection, State } from '../../src/protocol';
import type { PackageAction } from '../../src/apm/actions';
import type { Marketplace, PackageItem, Scope, UpdateRow } from '../../src/apm/types';
import type { Workflow, CommandRequest } from '../../src/apm/workflows';
import { parseMessage } from '../../src/protocol';

const bundle = buildSync({
  stdin: { contents: `${readFileSync('src/extension.ts', 'utf8')}\nexport { ApmExtension };`, resolveDir: resolve('src'), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode']
}).outputFiles[0].text;
const nodeRequire = createRequire(resolve('test/apm/taskRouting.test.ts'));
class ProcessExecution {
  constructor(readonly executable: string, readonly args: string[], readonly options: { cwd: string; env?: Record<string, string> }) {}
}
class Task {
  constructor(readonly definition: object, readonly scope: unknown, readonly name: string, readonly source: string, readonly execution: ProcessExecution) {}
}
interface Execution { task: Task; terminate(): void }
interface Panel { mode: 'native' | 'details' | 'browser'; extra: Partial<State>; item?: PackageItem; scope?: Scope; controller?: AbortController;
  detailsController?: AbortController; detailsRequest?: number; authenticationRepository?: { provider: 'github'; origin: string; path: string } }
interface Harness {
  toggleSection(section: PackageSection): Promise<void>;
  state: State;
  broadcast(): void;
  updateBadge(): void;
  signIn(): Promise<void>;
  refresh(): Promise<void>;
  refreshAll(): Promise<void>;
  scheduleRefresh(): void;
  refreshCatalog(client: unknown, marketplaces: Marketplace[]): Promise<{ items: PackageItem[]; errors: string[] }>;
  refreshUpdates(client: unknown, scope: Scope, installed: PackageItem[], previous: PackageItem[]): Promise<{ items: PackageItem[]; checkedAt?: string; error?: string }>;
  authenticationChanged(): void;
  report(error: unknown, context?: Panel): void;
  panels: Map<string, Panel>;
  epoch: number;
  runCommand(message: CommandRequest, context: Panel): Promise<void>;
  handle(message: Message, context: Panel): Promise<void>;
  dispose(): void;
  packageAction(action: PackageAction, context: Panel, scopeChosen?: boolean): Promise<void>;
  workflow(workflow: Workflow, uri?: unknown, scope?: Scope): Promise<void>;
  installPackage(scope?: Scope, preview?: boolean): Promise<void>;
  showTargets(context?: Panel): Promise<void>;
  reviewExecutableTrust(): Promise<void>;
  manageExecutableTrust(): Promise<void>;
}

function harness(options: { failStart?: boolean; finishDuringStart?: boolean; trusted?: boolean; root?: string;
  cancelConfirmation?: boolean; onConfirmation?: () => Promise<void>;
  errorChoice?: string;
  inputs?: (string | undefined)[]; picks?: (number | number[] | undefined)[]; scriptsEnabled?: boolean; token?: string;
  installed?: PackageItem[];
  tasks?: { definition: { workflow: string; script?: string }; scope: { uri: { fsPath: string } } }[];
  output?: (args: string[]) => { stdout: string; stderr: string; exitCode: number } } = {}) {
  const processListeners = new Set<(event: { execution: Execution; exitCode?: number }) => void>();
  const endListeners = new Set<(event: { execution: Execution }) => void>();
  const executions: Execution[] = [], argv: string[][] = [], messages: Partial<State>[] = [];
  const confirmations: string[] = [];
  const confirmationDetails: string[] = [];
  const errors: string[] = [];
  const progressLocations: unknown[] = [];
  const pickers: { title: string }[] = [];
  const prompts: string[] = [], notices: string[] = [], previews: { title: string; content: string }[] = [], opened: string[] = [], commands: string[] = [];
  const choices: { title: string; labels: string[] }[] = [];
  const executionScopes: (Scope | undefined)[] = [];
  const contexts = new Map<string, unknown>();
  const saved = new Map<string, unknown>();
  const inputs = [...options.inputs ?? []], picks = [...options.picks ?? []];
  const root = options.root ?? '/project';
  const executionInputs: (readonly string[] | undefined)[] = [];
  let serializations = 0, refreshes = 0, terminations = 0;
  const finish = (execution: Execution, exitCode?: number) => {
    for (const listener of [...processListeners]) listener({ execution, exitCode });
    for (const listener of [...endListeners]) listener({ execution });
  };
  const subscribe = <T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) => {
    listeners.add(listener);
    return { dispose: () => { listeners.delete(listener); } };
  };
  const vscode = {
    authentication: { getSession: async () => options.token ? { accessToken: options.token } : undefined },
    env: { remoteName: undefined },
    TreeItem: class { contextValue?: string; constructor(readonly label: string, readonly collapsibleState: number) {} },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    commands: { executeCommand: async (id: string, key?: string, value?: unknown) => {
      commands.push(id);
      if (id === 'setContext' && key) contexts.set(key, value);
    } },
    Task, ProcessExecution, TaskScope: { Workspace: 1, Global: 2 },
    TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 2 }, ProgressLocation: { Notification: 1 },
    QuickPickItemKind: { Separator: -1 },
    Uri: { file: (path: string) => ({ fsPath: path }) },
    workspace: {
      isTrusted: options.trusted !== false,
      getConfiguration: () => ({ get: (key: string) => key === 'tasks.includeScripts' ? options.scriptsEnabled ?? false : 'apm' }),
      getWorkspaceFolder: () => ({ name: 'project', uri: { fsPath: root } }),
      openTextDocument: async (uri: { fsPath: string }) => { opened.push(uri.fsPath); return { uri, getText: () => readFileSync(uri.fsPath, 'utf8') }; }
    },
    window: {
      createWebviewPanel: () => assert.fail('Native commands must never create a Tools webview'),
      showTextDocument: async () => {},
      showInputBox: async (input: { title: string; validateInput?: (value: string) => string | undefined }) => {
        prompts.push(input.title);
        const answer = inputs.shift();
        if (answer !== undefined) assert.equal(input.validateInput?.(answer), undefined);
        return answer;
      },
      showQuickPick: async (items: { label?: string }[], input: { title: string }) => {
        prompts.push(input.title); choices.push({ title: input.title, labels: Array.from(items, item => item.label ?? '') });
        const index = picks.shift(); return Array.isArray(index) ? index.map(i => items[i]) : index === undefined ? undefined : items[index];
      },
      showInformationMessage: async (message: string, ...actions: unknown[]) => {
        assert.ok(actions.every(action => typeof action === 'string'), 'Information messages must be non-modal notifications');
        notices.push(message); return undefined;
      },
      showErrorMessage: async (message: string, ...actions: unknown[]) => {
        assert.ok(actions.every(action => typeof action === 'string'), 'Errors must be non-modal notifications');
        errors.push(message); return options.errorChoice;
      },
      createQuickPick: () => {
        const picker = {
          title: '', selectedItems: [{ ref: 'v2' }], items: [], value: '', busy: false,
          show() {}, dispose() {},
          onDidAccept: (listener: () => void) => { queueMicrotask(listener); return { dispose() {} }; },
          onDidHide: () => ({ dispose() {} })
        };
        pickers.push(picker); return picker;
      },
      showWarningMessage: async (message: string, ...actions: unknown[]) => {
        assert.ok(actions.every(action => typeof action === 'string'), 'Warnings must be non-modal notifications');
        confirmations.push(message); confirmationDetails.push(message);
        await options.onConfirmation?.();
        return options.cancelConfirmation ? undefined : actions[0];
      },
      withProgress: async (options: { location: unknown }, operation: (progress: object, cancellation: object) => Promise<object>) => {
        progressLocations.push(options.location);
        return operation({}, { onCancellationRequested: () => ({ dispose() {} }) });
      }
    },
    tasks: {
      fetchTasks: async () => options.tasks ?? [],
      onDidEndTaskProcess: (listener: (event: { execution: Execution; exitCode?: number }) => void) => subscribe(processListeners, listener),
      onDidEndTask: (listener: (event: { execution: Execution }) => void) => subscribe(endListeners, listener),
      executeTask: async (task: Task) => {
        if (options.failStart) throw new Error('Task launch failed');
        const execution = { task, terminate: () => { terminations++; } };
        executions.push(execution);
        if (options.finishDuringStart) finish(execution, 0);
        return execution;
      }
    }
  };
  const module = { exports: { ApmExtension: { prototype: {} } } };
  runInNewContext(bundle, {
    module, exports: module.exports,
    require: (id: string) => id === 'vscode' ? vscode : nodeRequire(id),
    process, Buffer, console, setTimeout, clearTimeout, AbortController, URL, Date
  });
  const extension: Harness = Object.assign(Object.create(module.exports.ApmExtension.prototype), {
    context: { workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async (key: string, value: unknown) => { saved.set(key, value); } } },
    output: { appendLine() {}, show() {} },
    diagnostics: { clear() {}, begin: (key: string) => ({ key, generation: 0, run: 1 }) },
    state: { scopeKey: `workspace:${root}`, installed: [], catalog: [], marketplaces: [], scopes: [
      { kind: 'workspace', label: 'project', path: root },
      { kind: 'workspace', label: 'other', path: '/other' },
      { kind: 'global', label: 'Global (user)', path: '/home/test/.apm' }
    ] },
    nativeOperations: new Set(), results: new Map(), search: '', refreshNotices: new Set(), readmeNotices: new Set(),
    dependencyTree: { clear() {} },
    catalogSnapshots: new Map(), updateSnapshots: new Map(),
    authentication: { invalidate() {}, hosts: () => [] },
    settingsSync: { retry() {} },
    commandEnvironment: async () => options.token ? { GITHUB_APM_PAT: options.token } : {},
    allowRemoteImages: () => false,
    showTextResult: async (title: string, content: string) => { previews.push({ title, content }); },
    publishAudit: async () => {},
    loadDetails: async () => {},
    commandTasks: new Map(), queues: new Map(), panels: new Map(), subscriptions: [],
    requireTrust: () => { if (options.trusted === false) throw new Error('Trust this workspace'); },
    scope: (panel?: Panel) => panel?.scope ?? ({ kind: 'workspace', label: 'project', path: root }),
    client: (scope?: Scope) => ({
      supports: async () => true,
      getInstalled: async () => options.installed ?? [],
      execute: async (args: string[], execution?: { inputLines?: readonly string[] }) => {
        argv.push(args); executionInputs.push(execution?.inputLines); executionScopes.push(scope);
        if (execution?.inputLines && args[0] === 'init') {
          const [name, version, description, author] = execution.inputLines;
          await writeFile(join(root, 'apm.yml'), JSON.stringify({ name, version: version || '1.0.0', description: description || 'Detected description', author: author || 'Detected author' }));
        }
        return options.output?.(args) ?? { stdout: args.join(' ') === 'compile --help' ? '  --target TEXT  Values: claude, copilot, cursor.\n  --help' : '', stderr: '', exitCode: 0 };
      }
    }),
    serialize: async (_key: string, operation: () => Promise<void>) => { serializations++; await operation(); },
    send: (panel: Panel) => { messages.push({ ...panel.extra }); },
    scheduleRefresh: () => { refreshes++; }, refresh: async () => { refreshes++; }
  });
  const panel: Panel = { mode: 'native', extra: {} };
  const run = (id: string, commandOptions: Record<string, unknown> = {}) =>
    extension.runCommand({ type: 'command', id, args: {}, options: commandOptions }, panel);
  return {
    extension, panel, run, finish, executions, argv, executionInputs, executionScopes, choices, messages, confirmations, confirmationDetails, progressLocations, pickers, prompts, notices, errors, previews, opened, commands, contexts, saved,
    counts: () => ({ serializations, refreshes, terminations, processListeners: processListeners.size, endListeners: endListeners.size })
  };
}
test('direct package authentication errors offer contextual repository management', async () => {
  const h = harness({ errorChoice: 'Manage Repository Accounts' });
  const scope: Scope = { kind: 'workspace', label: 'project', path: '/project' };
  const panel: Panel = { mode: 'details', scope, extra: {}, item: {
    id: 'direct', name: 'direct', source: 'org/repo/plugins/demo#main', marketplace: '', version: '', installed: false
  } };
  let selected: unknown, selectedScope: unknown;
  Reflect.set(h.extension, 'manageAccounts', async (repository: unknown, scope: unknown) => { selected = repository; selectedScope = scope; });
  h.extension.report(new Error('No authorized account can access this repository.'), panel);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(selected)), { provider: 'github', origin: 'https://github.com', path: 'org/repo' });
  assert.equal(selectedScope, scope);
  panel.authenticationRepository = { provider: 'github', origin: 'https://github.com', path: 'other/dependency' };
  h.extension.report(new Error('No authorized account can access a dependency.'), panel);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(selected, panel.authenticationRepository);
});
test('account changes discard stale private details and invalidate pending detail requests', () => {
  const h = harness();
  const controller = new AbortController();
  const entry: Panel = { mode: 'details', detailsController: controller, detailsRequest: 3,
    extra: { details: { readme: 'Private documentation' }, readmeHtml: '<p>Private documentation</p>', busy: true } };
  h.extension.panels.set('private', entry);
  h.extension.epoch = 8;
  h.extension.authenticationChanged();
  assert.equal(controller.signal.aborted, true);
  assert.equal(entry.detailsRequest, 4);
  assert.equal(entry.extra.details, undefined);
  assert.equal(entry.extra.readmeHtml, undefined);
  assert.equal(entry.extra.busy, false);
  assert.equal(h.extension.epoch, 9);
  assert.equal(h.counts().refreshes, 1);
});
test('browser filters are persisted without CLI queries or filter echo loops', async () => {
  const h = harness();
  const controls: Panel = { mode: 'browser', extra: {} };
  await h.extension.handle({ type: 'filters', search: '@installed Two' }, controls);
  assert.equal(h.contexts.get('apm.filter.installed'), true);
  assert.equal(h.saved.get('browserSearch'), '@installed Two');
  await h.extension.handle({ type: 'filters', search: '@updates' }, controls);
  assert.equal(h.contexts.get('apm.filter.installed'), false);
  assert.equal(h.contexts.get('apm.filter.updates'), true);
  await h.extension.handle({ type: 'filters', search: '@dependencies' }, controls);
  assert.equal(h.contexts.get('apm.filter.dependencies'), true);
  assert.equal(h.argv.length, 0, 'Filters and section changes must not run additional CLI queries');
  const count = h.commands.length;
  await h.extension.handle({ type: 'filters', search: 'stale filter' }, { mode: 'details', extra: {} });
  await h.extension.handle({ type: 'filters', search: '@dependencies' }, controls);
  assert.equal(h.commands.length, count, 'Ignore detail-page filters and avoid search echo loops');
});
test('Views menu toggles persist independently from search and update native checkmarks', async () => {
  const h = harness();
  await h.extension.toggleSection('catalog');
  assert.equal(JSON.stringify(h.extension.state.hiddenSections), '["catalog"]');
  assert.equal(JSON.stringify(h.saved.get('hiddenSections')), '["catalog"]');
  assert.equal(h.contexts.get('apm.views.catalog'), false);
  assert.equal(h.contexts.get('apm.views.installed'), true);
  await h.extension.toggleSection('installed');
  await h.extension.toggleSection('updates');
  assert.equal(JSON.stringify(h.saved.get('hiddenSections')), '["catalog","installed","updates"]');
  await h.extension.toggleSection('catalog');
  assert.equal(h.contexts.get('apm.views.catalog'), true);
  assert.equal(h.contexts.get('apm.views.updates'), false);
  assert.equal(h.saved.has('browserSearch'), false);
  assert.equal(h.argv.length, 0);
});

test('refresh uses native view progress for its full lifetime and coalesces concurrent refreshes', async () => {
  const host = harness();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let runs = 0;
  Reflect.set(host.extension, 'doRefresh', async () => { runs++; await pending; });
  const refresh = () => Object.getPrototypeOf(host.extension).refresh.call(host.extension) as Promise<void>;
  const first = refresh();
  const second = refresh();
  assert.equal(runs, 1);
  assert.equal(JSON.stringify(host.progressLocations), '[{"viewId":"apm.browser"}]');
  assert.ok(Reflect.get(host.extension, 'refreshing'));
  release();
  await Promise.all([first, second]);
  assert.equal(Reflect.get(host.extension, 'refreshing'), undefined);
});

test('a command refresh consumes pending watcher timers and waits for mutations', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = harness();
  const prototype = Object.getPrototypeOf(host.extension);
  Reflect.set(host.extension, 'refresh', prototype.refresh);
  Reflect.set(host.extension, 'scheduleRefresh', prototype.scheduleRefresh);
  let runs = 0;
  Reflect.set(host.extension, 'doRefresh', async () => { runs++; });
  host.extension.scheduleRefresh();
  host.extension.scheduleRefresh();
  await host.extension.refresh();
  t.mock.timers.tick(1000);
  assert.equal(runs, 1, 'The command refresh replaces the debounced watcher refresh');

  const queues: Map<string, Promise<void>> = Reflect.get(host.extension, 'queues');
  queues.set('apm-mutations', Promise.resolve());
  host.extension.scheduleRefresh();
  t.mock.timers.tick(400);
  assert.equal(runs, 1, 'Do not refresh half-written manifests during a mutation');
  queues.delete('apm-mutations');
  await host.extension.refresh();
  t.mock.timers.tick(1000);
  assert.equal(runs, 2);
  host.extension.dispose();
});

test('automatic catalog refreshes reuse remote successes and failures for five minutes', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const host = harness();
  const marketplace: Marketplace = { name: 'catalog', source: 'org/catalog', ref: 'main' };
  const calls: string[] = [];
  const client = {
    getCatalog: async (entries: Marketplace[]) => {
      calls.push(entries[0].name);
      return { items: [], errors: entries[0].name === 'limited' ? ['limited: Repository service rate limit reached.'] : [] };
    }
  };
  const limited = { ...marketplace, name: 'limited' };
  const entries = [marketplace, limited];
  await host.extension.refreshCatalog(client, entries);
  now += 5 * 60_000 - 1;
  for (let i = 0; i < 10; i++) {
    const result = await host.extension.refreshCatalog(client, entries);
    assert.deepEqual(Array.from(result.errors), ['limited: Repository service rate limit reached.']);
  }
  assert.deepEqual(calls, ['catalog', 'limited']);
  now++;
  await host.extension.refreshCatalog(client, entries);
  assert.deepEqual(calls, ['catalog', 'limited', 'catalog', 'limited']);
  await host.extension.refreshAll();
  await host.extension.refreshCatalog(client, entries);
  assert.equal(calls.length, 6, 'Explicit Refresh bypasses the remote cache');
  await host.extension.refreshCatalog(client, [{ ...marketplace, ref: 'release' }, limited]);
  assert.equal(calls.length, 7, 'Changed registrations refresh immediately');
  const local = { ...marketplace, name: 'local', source: '/local/catalog' };
  await host.extension.refreshCatalog(client, [...entries, local]);
  await host.extension.refreshCatalog(client, [...entries, local]);
  assert.equal(calls.filter(name => name === 'local').length, 2, 'Local catalogs are not throttled');
});

test('automatic update checks are scoped, bounded and never reuse results for changed revisions', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const host = harness();
  const scope: Scope = { kind: 'workspace', label: 'project', path: '/project' };
  const item: PackageItem = { id: 'installed::org/pkg', name: 'org/pkg', marketplace: '', version: '1', installed: true,
    updateStatus: 'unchecked', metadata: { lock: { resolved_commit: 'old' } } };
  let calls = 0, fail = false;
  const client = {
    checkUpdates: async (): Promise<UpdateRow[]> => {
      calls++;
      if (fail) throw new Error('rate limit');
      return [{ package: item.name, current: '1', latest: '2', status: 'outdated', source: 'git' }];
    }
  };
  const first = await host.extension.refreshUpdates(client, scope, [item], []);
  for (let i = 0; i < 10; i++) {
    const cached = await host.extension.refreshUpdates(client, scope, [item], []);
    assert.equal(cached.items[0].updateStatus, 'outdated');
    assert.equal(cached.items[0].updateStale, undefined);
    assert.equal(cached.checkedAt, first.checkedAt);
  }
  assert.equal(calls, 1);
  const changed = { ...item, metadata: { lock: { resolved_commit: 'new' } } };
  const revised = await host.extension.refreshUpdates(client, scope, [changed], []);
  assert.equal(revised.items[0].updateStatus, 'unchecked');
  assert.equal(revised.items[0].latestVersion, undefined);
  await host.extension.refreshUpdates(client, { ...scope, path: '/other' }, [item], []);
  assert.equal(calls, 2);
  now += 5 * 60_000;
  fail = true;
  const failed = await host.extension.refreshUpdates(client, scope, [item], []);
  assert.match(failed.error ?? '', /rate limit/);
  assert.equal(failed.items[0].updateStale, true);
  await host.extension.refreshUpdates(client, scope, [item], []);
  assert.equal(calls, 3, 'Failed automatic checks also have a cooldown');
  await host.extension.refreshAll();
  await host.extension.refreshUpdates(client, scope, [item], []);
  assert.equal(calls, 4);
});

test('sign-in clears failed marketplace settings and refreshes the browser', async () => {
  const host = harness({ token: 'opaque-account-credential' });
  const calls: string[] = [];
  Reflect.set(host.extension, 'settingsSync', {
    retry: () => { calls.push('retry'); }
  });
  Reflect.set(host.extension, 'refresh', async () => { calls.push('refresh'); });
  await host.extension.signIn();
  assert.deepEqual(calls, ['retry', 'refresh']);
});

test('catalog refresh cannot overlap registry mutations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-refresh-queue-'));
  const host = harness({ root });
  const prototype = Object.getPrototypeOf(host.extension);
  Reflect.set(host.extension, 'serialize', prototype.serialize);
  Reflect.set(host.extension, 'settingsSync', { sync: async () => {} });
  Reflect.set(host.extension, 'broadcast', () => {});
  const calls: string[] = [];
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const catalogStarted = new Promise<void>(resolve => { started = resolve; });
  Reflect.set(host.extension, 'client', () => ({
    probe: async () => ({ version: '0.35.0', commands: [] }),
    getMarketplaces: async () => [{ name: 'catalog', source: 'org/catalog' }],
    getInstalled: async () => [],
    getCatalog: async () => {
      calls.push('catalog:start'); started();
      await pending;
      calls.push('catalog:end');
      return { items: [], errors: [] };
    }
  }));
  try {
    const refresh: Promise<void> = prototype.doRefresh.call(host.extension);
    await catalogStarted;
    const mutation: Promise<void> = prototype.serialize.call(host.extension, 'apm-mutations', async () => { calls.push('mutation'); });
    await Promise.resolve();
    assert.deepEqual(calls, ['catalog:start'], 'Registry mutations wait for marketplace update');
    release();
    await Promise.all([refresh, mutation]);
    assert.deepEqual(calls, ['catalog:start', 'catalog:end', 'mutation']);
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});

test('repeated browser and command refreshes do not repeat remote marketplace or outdated checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-refresh-counts-'));
  const host = harness({ root });
  const prototype = Object.getPrototypeOf(host.extension);
  Reflect.set(host.extension, 'serialize', prototype.serialize);
  Reflect.set(host.extension, 'settingsSync', { sync: async () => {}, retry() {} });
  Reflect.set(host.extension, 'broadcast', () => {});
  Reflect.set(host.extension, 'refresh', prototype.refresh);
  Reflect.set(host.extension, 'epoch', 0);
  const item: PackageItem = { id: 'installed::org/pkg', name: 'org/pkg', version: '1', marketplace: '', installed: true };
  const calls = { catalog: 0, installed: 0, outdated: 0 };
  Reflect.set(host.extension, 'client', () => ({
    probe: async () => ({ version: '0.35.0', commands: [] }),
    getMarketplaces: async () => [{ name: 'catalog', source: 'org/catalog' }],
    getInstalled: async () => { calls.installed++; return [item]; },
    getCatalog: async () => { calls.catalog++; return { items: [], errors: [] }; },
    checkUpdates: async () => {
      calls.outdated++;
      return [{ package: item.name, current: '1', latest: '1', status: 'current', source: 'git' }];
    }
  }));
  try {
    for (let i = 0; i < 10; i++) await host.extension.refresh();
    assert.deepEqual(host.errors, []);
    assert.deepEqual(calls, { catalog: 1, installed: 10, outdated: 1 });
    assert.equal(host.extension.state.installed[0].updateStatus, 'current');
    assert.equal(host.extension.state.installed[0].updateStale, undefined);
    await host.extension.refreshAll();
    assert.deepEqual(calls, { catalog: 2, installed: 11, outdated: 2 });
  } finally { host.extension.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('interactive APM tasks inherit the authorized VS Code account without putting tokens in arguments', async () => {
  const host = harness({ token: 'opaque-account-credential' });
  await host.run('compile', { '--watch': true });
  const execution = host.executions[0].task.execution;
  assert.equal(execution.options.env?.GITHUB_APM_PAT, 'opaque-account-credential');
  assert.ok(execution.args.every(arg => !arg.includes('opaque-account-credential')));
  host.extension.dispose();
});

test('refresh errors and compatibility warnings use deduplicated actionable notifications', () => {
  const host = harness();
  const state = Reflect.get(host.extension, 'state');
  state.errors = ['Catalog: network unavailable'];
  state.warning = 'Upgrade APM to the supported baseline.';
  const notify = () => Object.getPrototypeOf(host.extension).notifyRefresh.call(host.extension);
  notify(); notify();
  assert.deepEqual(host.errors, ['Catalog: network unavailable']);
  assert.deepEqual(host.confirmations, ['Upgrade APM to the supported baseline.']);
  state.errors = []; state.warning = undefined;
  notify();
  state.errors = ['Catalog: network unavailable'];
  notify();
  assert.equal(host.errors.length, 2, 'Failures that recur after recovery are reported again');
});

test('package execution failures reach VS Code error notifications', async () => {
  const host = harness({ output: () => ({ stdout: '', stderr: 'Package install failed', exitCode: 1 }) });
  host.panel.mode = 'details';
  host.panel.item = { id: 'one::sample', name: 'sample', marketplace: 'one', version: '1.0.0', installed: false };
  await host.extension.packageAction('install', host.panel, true);
  assert.match(host.confirmations[0], /Install sample.*Scope: project/);
  assert.deepEqual(host.errors, ['Package install failed']);
  assert.equal(host.panel.extra.actionResult?.status, 'failed');
});

test('README privacy guidance uses native notifications without repeating on every render', () => {
  const host = harness();
  const setReadme = (text: string) => Object.getPrototypeOf(host.extension).setReadme.call(host.extension, host.panel, text);
  setReadme('![chart](https://images.example.test/chart.png)');
  setReadme('![chart](https://images.example.test/chart.png)');
  assert.equal(host.notices.length, 1);
  assert.match(host.notices[0], /blocked for privacy/);
  setReadme('![chart](http://images.example.test/chart.png)');
  setReadme('![chart](http://images.example.test/chart.png)');
  assert.equal(host.confirmations.length, 1);
  assert.match(host.confirmations[0], /insecure HTTP/);
});

test('native install failures produce one error notification, not an inline error and a duplicate notification', async () => {
  const host = harness({ picks: [0, 0], inputs: ['org/example'], output: () => ({ stdout: '', stderr: 'Installation denied', exitCode: 1 }) });
  await host.extension.installPackage();
  assert.deepEqual(host.errors, ['Installation denied']);
  assert.equal(host.notices.length, 0, 'Failure must not produce an installation success notification');
});

test('watch mode is a shell-free task outside the bounded mutation queue and supports cancellation', async () => {
  const host = harness();
  await host.run('compile', { '--watch': true });
  await assert.rejects(host.extension.handle({ type: 'scope', key: 'workspace:/other' }, host.panel), /Stop the current command/);
  assert.equal(host.argv.length, 0);
  assert.equal(host.counts().serializations, 0);
  assert.deepEqual(Array.from(host.executions[0].task.execution.args), ['compile', '--watch']);
  assert.equal(host.executions[0].task.execution.options.cwd, '/project');
  assert.equal(host.panel.extra.taskRunning, true);
  await assert.rejects(host.run('compile', { '--watch': true }), /already running/);
  await host.extension.handle({ type: 'cancel' }, host.panel);
  assert.equal(host.counts().terminations, 1);
  host.finish(host.executions[0], 143);
  assert.equal(host.panel.extra.busy, false);
  assert.equal(host.panel.extra.taskRunning, false);
  assert.match(host.panel.extra.result ?? '', /cancelled.*Partial changes may remain/);
  assert.equal(host.panel.extra.error, undefined);
  assert.equal(host.counts().processListeners, 0);
  assert.equal(host.counts().endListeners, 0);
  await host.run('compile', { '--dry-run': true });
  assert.equal(host.counts().serializations, 0);
});

test('initializers preserve the interactive wizard unless defaults or discovery are selected explicitly', async () => {
  for (const id of ['init', 'plugin init']) {
    const host = harness();
    await host.run(id);
    assert.equal(host.executions.length, 1);
    assert.equal(host.executions[0].task.execution.args.includes('--yes'), false);
    host.finish(host.executions[0], 0);
    assert.match(host.panel.extra.result ?? '', /exit code 0/);
    await host.run(id, { '--yes': true });
    assert.equal(host.argv[0].includes('--yes'), true);
    assert.equal(host.executions.length, 1);
  }
  for (const flag of ['--discover', '--apply']) {
    const host = harness();
    await host.run('init', { [flag]: true });
    assert.equal(host.executions.length, 0);
    assert.ok(host.argv[0].includes(flag));
  }
});

test('task lifecycle handles startup failure, quick exits, external termination and extension disposal', async () => {
  const failed = harness({ failStart: true });
  await assert.rejects(failed.run('init'), /Task launch failed/);
  assert.equal(failed.panel.extra.busy, false);
  assert.equal(failed.counts().processListeners + failed.counts().endListeners, 0);

  const fast = harness({ finishDuringStart: true });
  await fast.run('init');
  assert.equal(fast.panel.extra.busy, false);
  assert.match(fast.panel.extra.result ?? '', /exit code 0/);
  assert.equal(fast.counts().refreshes, 1);

  const terminated = harness();
  await terminated.run('compile', { '--watch': true });
  terminated.finish(terminated.executions[0]);
  assert.match(terminated.panel.extra.result ?? '', /without an exit code/);
  assert.match(terminated.panel.extra.error ?? '', /did not complete successfully/);

  const disposed = harness();
  await disposed.run('compile', { '--watch': true });
  disposed.extension.dispose();
  assert.equal(disposed.counts().terminations, 1);
  assert.equal(disposed.counts().processListeners + disposed.counts().endListeners, 0);

  const untrusted = harness({ trusted: false });
  await assert.rejects(untrusted.run('init'), /Trust this workspace/);
  assert.equal(untrusted.executions.length, 0);
});

test('simultaneous confirmations cannot launch duplicate tasks on one page', async () => {
  const host = harness();
  const results = await Promise.allSettled([host.run('init'), host.run('init')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(host.executions.length, 1);
  host.finish(host.executions[0], 0);
  assert.equal(host.counts().processListeners + host.counts().endListeners, 0);
});

test('package previews do not mutate or refresh and applying preserves the preview options', async () => {
  const host = harness();
  host.panel.mode = 'details';
  host.panel.item = { id: 'one::sample', name: 'sample', marketplace: 'one', version: '1.0', installed: false };
  await host.extension.packageAction('previewInstall', host.panel, true);
  assert.deepEqual(Array.from(host.argv[0]), ['install', '--dry-run', 'sample@one']);
  assert.equal(host.counts().serializations, 0);
  assert.equal(host.counts().refreshes, 0);
  assert.equal(host.confirmations.length, 0);
  assert.equal(host.panel.extra.actionResult?.preview, true);
  assert.match(host.panel.extra.actionResult?.summary ?? '', /Preview only/);
  await host.extension.packageAction('applyPreview', host.panel);
  assert.deepEqual(Array.from(host.argv[1]), ['install', 'sample@one']);
  assert.equal(host.confirmations.length, 1);
  assert.equal(host.counts().serializations, 1);
  assert.equal(host.counts().refreshes, 1);
  await assert.rejects(host.extension.packageAction('applyPreview', host.panel), /successful preview/);
});

test('retry retains the original command scope and active commands reject scope changes', async () => {
  const host = harness();
  await host.run('compile', { '--dry-run': true });
  host.panel.scope = { kind: 'workspace', label: 'other', path: '/other' };
  await host.extension.handle({ type: 'retry' }, host.panel);
  assert.equal(host.panel.scope.path, '/project');
  await host.run('compile', { '--watch': true });
  await assert.rejects(host.run('compile'), /already running/);
  host.finish(host.executions[0], 0);
});

test('native initialization collects all CLI fields and initializes the selected directory, not a nested one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-native-command-'));
  try {
    const host = harness({ root, inputs: ['my-project', '2.3.4', 'My description', 'Example Author'], picks: [[1]] });
    await host.extension.workflow('initialize');
    assert.deepEqual(Array.from(host.argv[0]), ['compile', '--help']);
    assert.deepEqual(Array.from(host.argv[1]), ['init', '--target', 'copilot', '.']);
    assert.deepEqual(Array.from(host.executionInputs[1]!), ['my-project', '2.3.4', 'My description', 'Example Author', 'y']);
    assert.deepEqual(host.prompts, Array.from({ length: 5 }, (_, i) => `Initialize APM project (${i + 1}/5)`));
    for (const value of ['my-project', '2.3.4', 'My description', 'Example Author', 'copilot']) assert.ok(host.confirmationDetails[0].includes(value));
    assert.match(await readFile(join(root, 'apm.yml'), 'utf8'), /My description/);
    assert.deepEqual(host.opened, [join(root, 'apm.yml')]);
    assert.equal(host.executions.length, 0, 'Initialization must not launch a CLI wizard');
    await writeFile(join(root, 'apm.yml'), 'name: existing\n');
    const existing = harness({ root });
    await existing.extension.workflow('initialize');
    assert.equal(existing.argv.length, 0, 'Existing manifests are opened, not overwritten');
    const cancelled = harness({ root: join(root, 'other') });
    await cancelled.extension.workflow('initialize');
    assert.equal(cancelled.argv.length, 0);
    assert.equal(cancelled.confirmations.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancelling any initialization field or target choice never starts initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-init-cancel-'));
  try {
    for (let step = 0; step < 5; step++) {
      const host = harness({ root, inputs: ['sample', '1.2.3', 'Description', 'Author'].slice(0, step) });
      await host.extension.workflow('initialize');
      assert.equal(host.argv.some(args => args[0] === 'init'), false);
      assert.equal(host.confirmations.length, 0);
    }
    const auto = harness({ root, inputs: ['sample', '1.2.3', 'Description', 'Author'], picks: [[]] });
    await auto.extension.workflow('initialize');
    assert.deepEqual(Array.from(auto.argv[1]), ['init', '.'], 'Empty selection leaves target detection to APM');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('only the project name is required and blank metadata uses CLI defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-init-optional-'));
  try {
    const host = harness({ root, inputs: ['sample', '', '  ', ''], picks: [[]] });
    await host.extension.workflow('initialize');
    assert.deepEqual(Array.from(host.executionInputs[1]!), ['sample', '', '', '', 'y']);
    assert.match(host.confirmationDetails[0], /Version: APM default\nDescription: APM default\nAuthor: APM default/);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'apm.yml'), 'utf8')), {
      name: 'sample', version: '1.0.0', description: 'Detected description', author: 'Detected author'
    });
    assert.deepEqual(host.opened, [join(root, 'apm.yml')]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('initialization confirmation can be cancelled and newly created manifests are not overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-init-protect-'));
  try {
    const values = { root, inputs: ['sample', '1.2.3', 'Description', 'Author'], picks: [[]] };
    const cancelled = harness({ ...values, cancelConfirmation: true });
    await cancelled.extension.workflow('initialize');
    assert.equal(cancelled.argv.some(args => args[0] === 'init'), false);
    const raced = harness({ ...values, onConfirmation: () => writeFile(join(root, 'apm.yml'), 'name: keep-existing\n') });
    await assert.rejects(raced.extension.workflow('initialize'), /created while initialization was being configured/);
    assert.equal(raced.argv.some(args => args[0] === 'init'), false);
    assert.equal(await readFile(join(root, 'apm.yml'), 'utf8'), 'name: keep-existing\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native validation, previews and doctor execute without command forms or unnecessary confirmation', async () => {
  for (const [workflow, args] of [
    ['validate', ['compile', '--validate']],
    ['previewCompile', ['compile', '--dry-run']],
    ['doctor', ['doctor']]
  ] as const) {
    const host = harness();
    await host.extension.workflow(workflow);
    assert.deepEqual(Array.from(host.argv[0]), [...args]);
    assert.equal(host.confirmations.length, 0);
    assert.equal(host.executions.length, 0);
    assert.equal(host.previews.length, workflow === 'validate' ? 0 : 1);
    assert.equal(host.notices.length, workflow === 'validate' ? 1 : 0);
    assert.equal(host.counts().serializations, 0);
  }
  const failed = harness({ output: () => ({ stdout: '', stderr: 'Validation failed', exitCode: 2 }) });
  await assert.rejects(failed.extension.workflow('validate'), /exited with code 2/);
  const untrusted = harness({ trusted: false });
  await assert.rejects(untrusted.extension.workflow('validate'), /Trust/);
  assert.equal(untrusted.argv.length, 0);
});

test('policy explanations and read-only trust reports bypass the contract mutation annotation', async () => {
  const packageItem: PackageItem = {
    id: 'owner/repo', name: 'repo', marketplace: '', version: 'v1', source: 'owner/repo', installed: true,
    scope: { kind: 'workspace', label: 'project', path: '/project' }
  };
  const explanation = harness({
    installed: [packageItem], picks: [0],
    output: args => ({ stdout: args[0] === 'policy' ? 'Effective decision: denied' : '', stderr: '', exitCode: 0 })
  });
  await explanation.extension.workflow('policy');
  assert.deepEqual(Array.from(explanation.argv[0]), ['policy', 'explain', 'owner/repo']);
  assert.equal(explanation.confirmations.length, 0);
  assert.match(explanation.previews[0].content, /Effective decision: denied/);

  const report = harness({
    picks: [1],
    output: args => ({ stdout: args.join(' '), stderr: '', exitCode: 0 })
  });
  await report.extension.reviewExecutableTrust();
  assert.deepEqual(Array.from(report.argv[0]), ['approve', '--pending']);
  assert.equal(report.confirmations.length, 0);
  assert.match(report.previews[0].content, /approve --pending/);

  const status = harness({
    picks: [0],
    output: args => ({ stdout: args[0] === 'policy' ? '{"source":"org","rules":[]}' : '', stderr: '', exitCode: 0 })
  });
  await status.extension.reviewExecutableTrust();
  assert.deepEqual(Array.from(status.argv[0]), ['policy', 'status', '--json']);
  assert.match(status.previews[0].content, /"source": "org"/);
});

test('executable trust changes preserve package scope and confirm the personal destination', async () => {
  const globalScope: Scope = { kind: 'global', label: 'Global (user)', path: '/home/test/.apm' };
  const packageItem: PackageItem = {
    id: 'owner/repo', name: 'repo', marketplace: '', version: 'v1', source: 'owner/repo', installed: true, scope: globalScope
  };
  const approved = harness({ installed: [packageItem], picks: [2, 0, 0, 0] });
  await approved.extension.manageExecutableTrust();
  assert.deepEqual(Array.from(approved.argv[0]), ['approve', '--user', 'owner/repo']);
  assert.equal(approved.executionScopes[0]?.kind, 'global');
  assert.match(approved.confirmations[0], /your personal APM configuration/);
  assert.match(approved.confirmations[0], /Only proceed for sources you trust/);
  assert.match(approved.previews[0].content, /Exit code: 0/);

  const denied = harness({ installed: [packageItem], picks: [2, 0, 1, 0], cancelConfirmation: true });
  await denied.extension.manageExecutableTrust();
  assert.match(denied.confirmations[0], /Deny executable primitives for owner\/repo/);
  assert.equal(denied.argv.length, 0);
});

test('shared executable trust changes require an existing project manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-trust-policy-'));
  try {
    await writeFile(join(root, 'apm.yml'), 'name: trust-policy\n');
    const packageItem: PackageItem = {
      id: 'owner/repo', name: 'repo', marketplace: '', version: 'v1', source: 'owner/repo', installed: true,
      scope: { kind: 'workspace', label: 'project', path: root }
    };
    const host = harness({ root, installed: [packageItem], picks: [0, 0, 0, 0] });
    await host.extension.manageExecutableTrust();
    assert.deepEqual(Array.from(host.argv[0]), ['approve', 'owner/repo']);
    assert.match(host.confirmations[0], /the shared apm\.yml in project/);
    assert.equal(host.executionScopes[0]?.path, root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dependency links navigate to the package scope in the existing browser without running a tree command', async () => {
  const host = harness();
  await host.extension.handle({ type: 'dependencies' }, {
    mode: 'details', extra: {}, scope: { kind: 'workspace', label: 'other', path: '/other' }
  });
  assert.equal(Reflect.get(host.extension, 'state').scopeKey, 'workspace:/other');
  assert.equal(Reflect.get(host.extension, 'search'), '@dependencies');
  assert.ok(host.commands.includes('apm.browser.focus'));
  assert.equal(host.argv.length, 0);
  assert.equal(host.confirmations.length, 0);
  assert.equal(host.counts().refreshes, 1, 'Changing scope refreshes the normal browser data');
  assert.throws(() => parseMessage({ type: 'packageAction', action: 'tree' }), /malformed/);
  await assert.rejects(host.extension.handle({ type: 'dependencies' }, {
    mode: 'details', extra: {}, scope: { kind: 'workspace', label: 'closed', path: '/closed' }
  }), /no longer available/);
  const untrusted = harness({ trusted: false });
  await assert.rejects(untrusted.extension.handle({ type: 'dependencies' }, untrusted.panel), /Trust this workspace/);
});

test('native install gathers package source and leaves manifest targets unchanged', async () => {
  const host = harness({ picks: [0, 0], inputs: ['owner/repo#v2'] });
  await host.extension.installPackage();
  assert.deepEqual(host.prompts, ['Install APM package: destination', 'Install APM package', 'Install APM package']);
  assert.deepEqual(Array.from(host.argv[0]), ['install', '--global', 'owner/repo#v2']);
  assert.equal(host.confirmations.length, 1);
  const cancelled = harness({ picks: [0] });
  await cancelled.extension.installPackage();
  assert.equal(cancelled.argv.length, 0);
  const script = harness();
  await assert.rejects(script.extension.workflow('runScript'), /includeScripts/);
  assert.equal(script.executions.length, 0);
});

test('native audit reveals Problems even when the CLI reports a nonzero finding status', async () => {
  const host = harness({ output: () => ({ stdout: JSON.stringify({ passed: false, summary: { critical: 1 }, findings: [] }), stderr: '', exitCode: 1 }) });
  await host.extension.workflow('auditWorkspace');
  assert.deepEqual(Array.from(host.argv[0]), ['audit', '--format', 'json']);
  assert.ok(host.commands.includes('workbench.actions.view.problems'));
  assert.match(host.notices[0], /reported findings or incomplete coverage/);
  assert.equal(host.confirmations.length, 0, 'Read-only auditing must not warn about applying changes');
});

test('deployment explanations use native pickers and removed generic messages are rejected', async () => {
  const host = harness({ output: () => ({ stdout: JSON.stringify([{ target: 'copilot', status: 'active', source: 'apm.yml', deploy_dir: '.github/' }]), stderr: '', exitCode: 0 }) });
  await host.extension.showTargets();
  assert.deepEqual(Array.from(host.argv[0]), ['targets', '--json']);
  assert.match(host.prompts[0], /APM deployment targets/);
  for (const type of ['tools', 'selectCommand', 'command', 'help']) assert.throws(() => parseMessage({ type, id: 'install', args: {}, options: {} }), /Unknown/);
});

test('native script selection starts only the chosen folder-bound VS Code task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-native-script-'));
  try {
    await writeFile(join(root, 'apm.yml'), 'name: test\nscripts:\n  check: echo explicit-only\n  build: echo build\n');
    const tasks = [
      { definition: { workflow: 'script', script: 'check' }, scope: { uri: { fsPath: '/other' } } },
      { definition: { workflow: 'script', script: 'check' }, scope: { uri: { fsPath: root } } }
    ];
    const host = harness({ root, scriptsEnabled: true, picks: [0], tasks });
    await host.extension.workflow('runScript');
    assert.deepEqual(host.prompts, ['Run APM project script']);
    assert.equal(host.executions.length, 1);
    assert.equal(host.executions[0].task, tasks[1]);
    assert.equal(host.argv.length, 0, 'Native selection delegates execution to the existing guarded task provider');
    const cancelled = harness({ root, scriptsEnabled: true, tasks });
    await cancelled.extension.workflow('runScript');
    assert.equal(cancelled.executions.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('version installs and previews leave target resolution to the manifest', async () => {
  for (const action of ['installWithOptions', 'previewWithOptions'] as const) {
    const host = harness();
    host.panel.mode = 'details';
    host.panel.item = { id: 'one::sample', name: 'sample', marketplace: 'one', version: '1.0', installed: false };
    await host.extension.packageAction(action, host.panel, true);
    assert.equal(host.pickers.length, 1, 'Only the version/ref picker is shown');
    assert.doesNotMatch(host.pickers[0].title, /target|1\/2/);
    assert.equal(host.argv.length, 2, 'Only version discovery and installation run');
    assert.equal(host.argv[0][0], 'view');
    assert.deepEqual(Array.from(host.argv[1]), action === 'previewWithOptions'
      ? ['install', '--dry-run', 'sample@one#v2'] : ['install', 'sample@one#v2']);
    if (action === 'previewWithOptions') {
      await host.extension.packageAction('applyPreview', host.panel);
      assert.deepEqual(Array.from(host.argv[2]), ['install', 'sample@one#v2']);
    }
  }
});

test('install asks destination first, defaults to an initialized workspace and honors global selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-install-scopes-'));
  try {
    await writeFile(join(root, 'apm.yml'), 'name: project\n');
    for (const index of [0, 1]) {
      const host = harness({ root, picks: [index, 0], inputs: ['org/example'] });
      await host.extension.installPackage();
      assert.equal(host.prompts[0], 'Install APM package: destination');
      assert.deepEqual(host.choices[0].labels, ['Workspace: project', 'Global (user)']);
      assert.equal(host.executionScopes[0]?.kind, index === 0 ? 'workspace' : 'global');
      assert.equal(host.executionScopes[0]?.path, index === 0 ? root : '/home/test/.apm');
      assert.equal(host.argv[0].includes('--global'), index === 1);
      assert.match(host.confirmations[0], index === 0 ? /Scope: project/ : /Scope: Global \(user\)/);
    }
    const cancelled = harness({ root });
    await cancelled.extension.installPackage();
    assert.equal(cancelled.prompts.length, 1);
    assert.equal(cancelled.argv.length, 0);
    assert.equal(cancelled.confirmations.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('without a manifest installation defaults to global and does not initialize the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-global-only-'));
  try {
    const host = harness({ root, picks: [0, 0], inputs: ['org/example'] });
    await host.extension.installPackage();
    assert.deepEqual(host.choices[0].labels, ['Global (user)']);
    assert.deepEqual(Array.from(host.argv[0]), ['install', '--global', 'org/example']);
    await assert.rejects(readFile(join(root, 'apm.yml')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('package install previews choose a destination but applying and uninstalling never switch scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-preview-scopes-'));
  try {
    await writeFile(join(root, 'apm.yml'), 'name: project\n');
    const host = harness({ root, picks: [1] });
    host.panel.mode = 'details';
    host.panel.item = { id: 'one::sample', name: 'sample', marketplace: 'one', version: '1', installed: false };
    await host.extension.packageAction('previewInstall', host.panel);
    assert.deepEqual(Array.from(host.argv[0]), ['install', '--dry-run', '--global', 'sample@one']);
    assert.equal(host.panel.scope?.kind, 'global');
    await host.extension.packageAction('applyPreview', host.panel);
    assert.deepEqual(Array.from(host.argv[1]), ['install', '--global', 'sample@one']);
    assert.equal(host.prompts.length, 1, 'Applying keeps the preview destination');
    const global = host.panel.scope!;
    const user = { ...host.panel.item!, installed: true, scope: global };
    const project = { ...user, scope: { kind: 'workspace' as const, label: 'project', path: root } };
    host.extension.state.installed = [project, user];
    host.panel.item = user;
    await host.extension.packageAction('uninstall', host.panel);
    assert.deepEqual(Array.from(host.argv[2]), ['uninstall', '--global', 'sample@one']);
    assert.equal(host.executionScopes[2]?.kind, 'global');
    assert.equal(host.prompts.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('refresh lists and checks both scopes independently and keeps global results without a project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-dual-refresh-'));
  const host = harness({ root });
  const prototype = Object.getPrototypeOf(host.extension);
  const item: PackageItem = { id: 'one::sample', name: 'sample', marketplace: 'one', version: '1', installed: true,
    metadata: { cliIdentity: 'org/sample' } };
  const reads: string[] = [], checks: string[] = [];
  let failGlobal = false;
  Reflect.set(host.extension, 'serialize', prototype.serialize);
  Reflect.set(host.extension, 'settingsSync', { sync: async () => {} });
  Reflect.set(host.extension, 'broadcast', () => {});
  Reflect.set(host.extension, 'epoch', 0);
  Reflect.set(host.extension, 'client', (scope: Scope) => ({
    probe: async () => ({ version: '0.35.0', commands: [] }),
    getMarketplaces: async () => [],
    getInstalled: async () => {
      reads.push(scope.kind);
      if (failGlobal && scope.kind === 'global') throw new Error('Global list unavailable');
      return [{ ...item, version: scope.kind === 'global' ? '1' : '2' }];
    },
    checkUpdates: async () => {
      checks.push(scope.kind);
      return [{ package: 'org/sample', current: scope.kind === 'global' ? '1' : '2', latest: '2',
        status: scope.kind === 'global' ? 'outdated' : 'current', source: 'git' }];
    }
  }));
  try {
    await writeFile(join(root, 'apm.yml'), 'name: project\n');
    host.extension.state.catalog = [{ ...item, installed: false }];
    Reflect.set(host.extension, 'refreshCatalog', async () => ({ items: [{ ...item, installed: false }], errors: [] }));
    await prototype.doRefresh.call(host.extension);
    assert.deepEqual(reads, ['global', 'workspace']);
    assert.deepEqual(checks, ['global', 'workspace']);
    assert.deepEqual(Array.from(host.extension.state.installed, item => [item.scope?.kind, item.version, item.updateStatus]),
      [['global', '1', 'outdated'], ['workspace', '2', 'current']]);
    assert.equal(host.extension.state.catalog[0].installations?.length, 2);
    const opened: Scope[] = [];
    Reflect.set(host.extension, 'openPackageDetails', async (_item: PackageItem, scope: Scope) => { opened.push(scope); });
    await host.extension.handle({ type: 'details', id: item.id, scopeKey: 'global:/home/test/.apm' }, { mode: 'browser', extra: {} });
    await host.extension.handle({ type: 'details', id: item.id, scopeKey: `workspace:${root}` }, { mode: 'browser', extra: {} });
    assert.deepEqual(opened.map(scope => scope.kind), ['global', 'workspace']);
    await assert.rejects(host.extension.handle({ type: 'details', id: item.id, scopeKey: 'workspace:/closed' },
      { mode: 'browser', extra: {} }), /no longer available/);
    assert.throws(() => parseMessage({ type: 'details', id: item.id, scopeKey: 123 }), /Invalid/);
    reads.length = 0;
    await rm(join(root, 'apm.yml'));
    await prototype.doRefresh.call(host.extension);
    assert.deepEqual(reads, ['global']);
    assert.equal(host.extension.state.projectPresent, false);
    assert.equal(host.extension.state.installed.length, 1);
    assert.equal(host.extension.state.installed[0].scope?.kind, 'global');
    assert.equal(host.extension.state.catalog[0].installations?.length, 1);
    await writeFile(join(root, 'apm.yml'), 'name: project\n');
    failGlobal = true;
    await prototype.doRefresh.call(host.extension);
    assert.ok(host.extension.state.errors.some(error => /Installed: Global.*unavailable/.test(error)));
    assert.equal(host.extension.state.installed.find(item => item.scope?.kind === 'workspace')?.updateStatus, 'current');
    assert.equal(host.extension.state.installed.find(item => item.scope?.kind === 'global')?.updateStale, true);
    failGlobal = false;
    const global = host.extension.state.scopes.find(scope => scope.kind === 'global')!;
    host.extension.state.scopes = [global];
    Reflect.set(host.extension, 'scope', () => global);
    reads.length = 0;
    await prototype.doRefresh.call(host.extension);
    assert.deepEqual(reads, ['global']);
    assert.equal(host.extension.state.installed.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('updating a global duplicate verifies only that installation and invalidates only its update cache', async () => {
  const host = harness();
  const global = host.extension.state.scopes.find(scope => scope.kind === 'global')!;
  const workspace = host.extension.state.scopes.find(scope => scope.path === '/project')!;
  const item: PackageItem = { id: 'one::sample', name: 'sample', marketplace: 'one', version: '1', installed: true,
    updateStatus: 'outdated', latestVersion: '2', metadata: { cliIdentity: 'org/sample' } };
  const user = { ...item, scope: global }, project = { ...item, scope: workspace };
  host.panel.mode = 'details'; host.panel.item = user; host.panel.scope = global;
  host.extension.state.installed = [project, user];
  const snapshots = new Map([['global:/home/test/.apm', {}], ['workspace:/project', {}]]);
  Reflect.set(host.extension, 'updateSnapshots', snapshots);
  Reflect.set(host.extension, 'refresh', async () => {
    const updated = { ...user, version: '2', updateStatus: 'current' as const };
    host.extension.state.installed = [project, updated];
    host.panel.item = updated;
  });
  await host.extension.packageAction('update', host.panel);
  assert.deepEqual(Array.from(host.argv[0]), ['update', '--yes', '--global', 'org/sample']);
  assert.equal(host.executionScopes[0]?.kind, 'global');
  assert.equal(host.panel.extra.actionResult?.status, 'success');
  assert.match(host.panel.extra.actionResult?.summary ?? '', /Update verified/);
  assert.equal(project.updateStatus, 'outdated');
  assert.equal(snapshots.has('global:/home/test/.apm'), false);
  assert.equal(snapshots.has('workspace:/project'), true);
  assert.equal(host.prompts.length, 0, 'Updates never ask for another destination');
});
