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
import type { PackageItem, Scope } from '../../src/apm/types';
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
interface Panel { mode: 'native' | 'details' | 'browser'; extra: Partial<State>; item?: PackageItem; scope?: Scope; controller?: AbortController }
interface Harness {
  toggleSection(section: PackageSection): Promise<void>;
  state: State;
  broadcast(): void;
  updateBadge(): void;
  signIn(): Promise<void>;
  runCommand(message: CommandRequest, context: Panel): Promise<void>;
  handle(message: Message, context: Panel): Promise<void>;
  dispose(): void;
  packageAction(action: PackageAction, context: Panel): Promise<void>;
  workflow(workflow: Workflow, uri?: unknown, scope?: Scope): Promise<void>;
  installPackage(scope?: Scope, preview?: boolean): Promise<void>;
  showTargets(context?: Panel): Promise<void>;
}

function harness(options: { failStart?: boolean; finishDuringStart?: boolean; trusted?: boolean; root?: string;
  cancelConfirmation?: boolean; onConfirmation?: () => Promise<void>;
  inputs?: (string | undefined)[]; picks?: (number | number[] | undefined)[]; scriptsEnabled?: boolean; token?: string;
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
      showQuickPick: async (items: object[], input: { title: string }) => { prompts.push(input.title); const index = picks.shift(); return Array.isArray(index) ? index.map(i => items[i]) : index === undefined ? undefined : items[index]; },
      showInformationMessage: async (message: string, ...actions: unknown[]) => {
        assert.ok(actions.every(action => typeof action === 'string'), 'Information messages must be non-modal notifications');
        notices.push(message); return undefined;
      },
      showErrorMessage: async (message: string, ...actions: unknown[]) => {
        assert.ok(actions.every(action => typeof action === 'string'), 'Errors must be non-modal notifications');
        errors.push(message); return undefined;
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
    process, Buffer, console, setTimeout, clearTimeout, AbortController, URL
  });
  const extension: Harness = Object.assign(Object.create(module.exports.ApmExtension.prototype), {
    context: { workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async (key: string, value: unknown) => { saved.set(key, value); } } },
    output: { appendLine() {}, show() {} },
    diagnostics: { clear() {}, begin: (key: string) => ({ key, generation: 0, run: 1 }) },
    state: { scopeKey: `workspace:${root}`, installed: [], catalog: [], marketplaces: [], scopes: [{ kind: 'workspace', label: 'other', path: '/other' }] },
    nativeOperations: new Set(), results: new Map(), search: '', refreshNotices: new Set(), readmeNotices: new Set(),
    allowRemoteImages: () => false,
    showTextResult: async (title: string, content: string) => { previews.push({ title, content }); },
    publishAudit: async () => {},
    loadDetails: async () => {},
    commandTasks: new Map(), queues: new Map(), panels: new Map(), subscriptions: [],
    requireTrust: () => { if (options.trusted === false) throw new Error('Trust this workspace'); },
    scope: (panel?: Panel) => panel?.scope ?? ({ kind: 'workspace', label: 'project', path: root }),
    client: () => ({
      supports: async () => true,
      getInstalled: async () => [],
      execute: async (args: string[], execution?: { inputLines?: readonly string[] }) => {
        argv.push(args); executionInputs.push(execution?.inputLines);
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
    extension, panel, run, finish, executions, argv, executionInputs, messages, confirmations, confirmationDetails, progressLocations, pickers, prompts, notices, errors, previews, opened, commands, contexts, saved,
    counts: () => ({ serializations, refreshes, terminations, processListeners: processListeners.size, endListeners: endListeners.size })
  };
}
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
  await host.extension.packageAction('install', host.panel);
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
  const host = harness({ picks: [0], inputs: ['org/example'], output: () => ({ stdout: '', stderr: 'Installation denied', exitCode: 1 }) });
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
  await host.extension.packageAction('previewInstall', host.panel);
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
  const host = harness({ picks: [0], inputs: ['owner/repo#v2'] });
  await host.extension.installPackage();
  assert.deepEqual(host.prompts, ['Install APM package', 'Install APM package']);
  assert.deepEqual(Array.from(host.argv[0]), ['install', 'owner/repo#v2']);
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
    await host.extension.packageAction(action, host.panel);
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
