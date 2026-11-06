import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { resolvedTargets, recoveryActions, isWorkflow } from '../../src/apm/workflows';
import { parseMessage } from '../../src/protocol';
import { ApmClient } from '../../src/apm/client';
import type { ContentGroup } from '../../src/apm/contents';
import type { AuditReport } from '../../src/apm/actions';

const source = buildSync({
  stdin: { contents: "export * from './navigation'; export * from './manifestAssistance'; export * from './taskProvider';", resolveDir: resolve('src'), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode']
}).outputFiles[0].text;
const nodeRequire = createRequire(resolve('test/apm/nativeUx.test.ts'));
class Uri {
  constructor(readonly scheme: string, readonly path: string, readonly query = '') {}
  get fsPath() { return this.path; }
  toString() { return `${this.scheme}:${this.path}?${this.query}`; }
  static file(path: string) { return new Uri('file', path); }
  static from(value: { scheme: string; path: string; query?: string }) { return new Uri(value.scheme, value.path, value.query); }
  static parse(value: string) { const split = value.indexOf(':'); return new Uri(value.slice(0, split), value.slice(split + 1)); }
}
class Range { constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {} }
class Diagnostic {
  source?: string; code?: string;
  constructor(readonly range: Range, readonly message: string, readonly severity: number) {}
}
const disposable = () => ({ dispose() {} });
type Native = typeof import('../../src/navigation') & typeof import('../../src/manifestAssistance') & typeof import('../../src/taskProvider');
function harness(root: string, trusted = true, includeScripts = false) {
  const diagnostics = new Map<string, Diagnostic[]>();
  const providers: Record<string, object> = {};
  const folder = { name: 'project', uri: Uri.file(root), index: 0 };
  class Task {
    constructor(readonly definition: object, readonly scope: object, readonly name: string, readonly source: string, readonly execution: object) {}
  }
  const vscode = {
    authentication: { getSession: async () => undefined },
    Uri, Range, Diagnostic, DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    RelativePattern: class { constructor(readonly root: Uri, readonly pattern: string) {} },
    EventEmitter: class { event = () => disposable(); fire() {} dispose() {} },
    Task, CustomExecution: class { constructor(readonly callback: () => Promise<object>) {} },
    TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 2 },
    workspace: {
      isTrusted: trusted, workspaceFolders: [folder], textDocuments: [],
      getConfiguration: () => ({ get: (_name: string, fallback: unknown) => _name === 'tasks.includeScripts' ? includeScripts : fallback }),
      registerTextDocumentContentProvider: (_scheme: string, provider: object) => { providers.decoded = provider; return disposable(); },
      createFileSystemWatcher: () => ({
        ...disposable(),
        onDidChange: (listener: object) => { providers.fileChange = listener; return disposable(); },
        onDidDelete: (listener: object) => { providers.fileDelete = listener; return disposable(); },
        onDidCreate: (listener: object) => { providers.fileCreate = listener; return disposable(); }
      }),
      onDidChangeTextDocument: (listener: object) => { providers.documentChange = listener; return disposable(); },
      onDidDeleteFiles: disposable,
      onDidChangeWorkspaceFolders: (listener: object) => { providers.foldersChange = listener; return disposable(); },
      onDidChangeConfiguration: (listener: object) => { providers.configurationChange = listener; return disposable(); },
      onDidOpenTextDocument: disposable, onDidCloseTextDocument: disposable
    },
    languages: {
      createDiagnosticCollection: () => ({
        has: (uri: Uri) => diagnostics.has(uri.toString()), clear: () => diagnostics.clear(), dispose() {},
        delete: (uri: Uri) => diagnostics.delete(uri.toString()),
        set: (uri: Uri, values: Diagnostic[]) => diagnostics.set(uri.toString(), values)
      }),
      registerCodeActionsProvider: (_selector: unknown, provider: object) => { providers.actions = provider; return disposable(); },
      registerCompletionItemProvider: (_selector: unknown, provider: object) => { providers.completions = provider; return disposable(); },
      registerHoverProvider: (_selector: unknown, provider: object) => { providers.hovers = provider; return disposable(); },
      registerDocumentLinkProvider: (_selector: unknown, provider: object) => { providers.links = provider; return disposable(); }
    },
    tasks: { registerTaskProvider: (_type: string, provider: object) => { providers.tasks = provider; return disposable(); } },
    extensions: { getExtension: () => undefined },
    commands: { registerCommand: disposable },
    Disposable: { from: (...items: { dispose(): void }[]) => ({ dispose() { for (const item of items) item.dispose(); } }) },
    CompletionItemKind: { Property: 1, EnumMember: 2 }, CodeActionKind: { Source: 'source', QuickFix: 'quickfix' },
    CompletionItem: class { constructor(readonly label: string) {} },
    SnippetString: class { constructor(readonly value: string) {} }
  };
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, require: (id: string) => id === 'vscode' ? vscode : nodeRequire(id),
    process, Buffer, console, setTimeout, clearTimeout, AbortController, URL });
  return { api: module.exports as Native, providers, diagnostics, folder };
}

test('target and recovery adapters reflect null sources and reject malformed rows/messages', () => {
  assert.deepEqual(resolvedTargets('[{"target":"copilot","status":"inactive","source":null,"deploy_dir":".github/","needs":"marker"}]'),
    [{ target: 'copilot', status: 'inactive', source: 'No activation source reported', deployDir: '.github/', needs: 'marker' }]);
  assert.throws(() => resolvedTargets('{}'), /expected an array/);
  assert.throws(() => resolvedTargets('[{"target":"x","status":true}]'), /Unrecognized/);
  assert.equal(isWorkflow('toString'), false);
  assert.throws(() => parseMessage({ type: 'workflow', workflow: '__proto__' }), /Unknown/);
  assert.deepEqual(parseMessage({ type: 'workflow', workflow: 'doctor' }), { type: 'workflow', workflow: 'doctor' });
  assert.deepEqual(parseMessage({ type: 'navigate', id: 'content:0' }), { type: 'navigate', id: 'content:0' });
  assert.ok(recoveryActions('Authentication failed (401)').includes('authentication'));
  assert.ok(recoveryActions('No marketplace.json found in owner/private').includes('authentication'));
  assert.ok(recoveryActions('Repository not found (404)').includes('authentication'));
  assert.ok(!recoveryActions('Operation exited 1').includes('authentication'));
  assert.ok(recoveryActions('blocked by organization policy').includes('policy'));
});

test('package navigation verifies files and refuses symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-navigation-'));
  try {
    await mkdir(join(root, 'skills', 'sample'), { recursive: true });
    await writeFile(join(root, 'skills', 'sample', 'SKILL.md'), '# Sample');
    const host = harness(root);
    const groups: ContentGroup[] = [{ kind: 'skills', items: [{ name: 'sample', path: 'skills/sample', navigationId: 'untrusted' }, { name: 'missing', path: 'missing' }] }];
    const links = await host.api.contentNavigation(root, groups, true);
    assert.equal(links.size, 1);
    assert.equal(groups[0].items[0].navigationId, 'content:0');
    assert.equal(groups[0].items[0].locationKind, 'installed');
    assert.equal(groups[0].items[1].navigationId, undefined);
    await symlink(tmpdir(), join(root, 'outside'));
    await assert.rejects(host.api.contentNavigation(root, [{ kind: 'skills', items: [{ name: 'escape', path: 'outside' }] }], true), /escapes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Problems separates physical and decoded locations, coverage and scope replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-diagnostics-'));
  try {
    await writeFile(join(root, 'prompt.json'), '{"prompt":"first\\nsecond"}');
    await writeFile(join(root, 'source.md'), 'first\nsecond');
    const host = harness(root);
    const diagnostics = new host.api.AuditDiagnostics();
    const report: AuditReport = { passed: false, summary: {}, findings: [
      { file: 'source.md', severity: 'high', message: 'physical', line: 2, column: 2, remediation: 'Review text' },
      { file: 'prompt.json', severity: 'medium', message: 'decoded', pointer: '/prompt', decodedLine: 2, decodedColumn: 1 }
    ], coverage: { complete: false, primitives: [{ file: 'source.md', status: 'incomplete', diagnostic: 'Could not scan fully' }] } };
    const links = await diagnostics.publish({ kind: 'workspace', label: 'project', path: root }, report);
    assert.equal(links.size, 2);
    const physical = [...host.diagnostics.entries()].find(([uri]) => uri.replaceAll('\\', '/').endsWith('/source.md?'))![1];
    assert.equal(physical[0].range.startLine, 1);
    assert.match(physical[0].message, /Remediation/);
    assert.match(physical[1].message, /Incomplete APM scan/);
    const decoded = [...host.diagnostics.entries()].find(([uri]) => uri.startsWith('apm-decoded:'))!;
    assert.equal(decoded[1][0].range.startLine, 1);
    const provider = host.providers.decoded as { provideTextDocumentContent(uri: { toString(): string }): string };
    assert.equal(provider.provideTextDocumentContent({ toString: () => decoded[0] }), 'first\nsecond');
    await diagnostics.publish({ kind: 'workspace', label: 'project', path: root }, { passed: true, summary: {}, findings: [] });
    assert.equal(host.diagnostics.size, 0);
    const ticket = diagnostics.begin(root);
    const change = host.providers.documentChange as (event: { document: { uri: Uri } }) => void;
    change({ document: { uri: Uri.file(join(root, 'source.md')) } });
    const stale: AuditReport = { passed: true, summary: {}, findings: [] };
    assert.equal((await diagnostics.publish({ kind: 'workspace', label: 'project', path: root }, stale, root, ticket)).size, 0);
    assert.equal(stale.stale, true);
    assert.equal(stale.passed, false);
    const older = diagnostics.begin(root), newer = diagnostics.begin(root);
    const current: AuditReport = { passed: false, summary: {}, findings: [
      { file: 'prompt.json', severity: 'medium', message: 'current decoded finding', pointer: '/prompt', decodedLine: 1 }
    ] };
    const currentLinks = await diagnostics.publish({ kind: 'workspace', label: 'project', path: root }, current, root, newer);
    const obsolete: AuditReport = { passed: true, summary: {}, findings: [] };
    await diagnostics.publish({ kind: 'workspace', label: 'project', path: root }, obsolete, root, older);
    assert.equal(obsolete.stale, true);
    assert.equal(host.diagnostics.size, 1, 'An obsolete run must not clear the newer result');
    assert.notEqual(currentLinks.values().next().value?.uri?.toString(), decoded[0]);
    change({ document: { uri: Uri.file(join(root, 'prompt.json')) } });
    assert.equal(host.diagnostics.size, 0, 'Editing a physical source clears its decoded diagnostics before saving');
    diagnostics.dispose();
    await assert.rejects(new (harness(root, false).api.AuditDiagnostics)().publish({ kind: 'workspace', label: 'project', path: root }, report), /Trust/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('task discovery and resolution are local, folder-bound and scripts opt in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-tasks-'));
  try {
    await writeFile(join(root, 'apm.yml'), 'name: test\nversion: 1.0.0\nscripts:\n  check: echo safe\n');
    const host = harness(root);
    const registration = host.api.registerApmTaskProvider(message => assert.fail(message));
    const provider = host.providers.tasks as { provideTasks(): Promise<{ definition: { workflow: string }; scope: object }[]>; resolveTask(task: object): object };
    const tasks = await provider.provideTasks();
    assert.deepEqual(Array.from(tasks, task => task.definition.workflow), ['compile', 'watch', 'validate', 'audit']);
    assert.ok(tasks.every(task => task.scope === host.folder));
    assert.equal(await provider.provideTasks(), tasks, 'Repeated requests reuse completed discovery');
    for (const event of ['fileCreate', 'fileChange', 'fileDelete', 'foldersChange']) {
      (host.providers[event] as () => void)();
      const first = provider.provideTasks();
      assert.equal(provider.provideTasks(), first, 'Concurrent requests share pending discovery');
      assert.notEqual(await first, tasks, `${event} invalidates discovery`);
    }
    const beforeConfiguration = await provider.provideTasks();
    const configurationChange = host.providers.configurationChange as (event: { affectsConfiguration(section: string): boolean }) => void;
    configurationChange({ affectsConfiguration: () => false });
    assert.equal(await provider.provideTasks(), beforeConfiguration, 'Unrelated settings retain discovery');
    configurationChange({ affectsConfiguration: section => section === 'apm.tasks.includeScripts' });
    assert.notEqual(await provider.provideTasks(), beforeConfiguration, 'Script settings invalidate discovery');
    assert.throws(() => provider.resolveTask({ definition: { type: 'apm', workflow: 'compile', executable: 'unsafe' }, scope: host.folder }), /Invalid/);
    assert.throws(() => provider.resolveTask({ definition: { type: 'apm', workflow: 'compile' }, scope: 1 }), /explicit/);
    assert.deepEqual(Array.from(host.api.taskArguments({ type: 'apm', workflow: 'watch' })), ['compile', '--watch']);
    assert.throws(() => host.api.taskArguments({ type: 'apm', workflow: 'script', script: '--unsafe' }), /valid/);
    registration.dispose();
    const optedIn = harness(root, true, true);
    optedIn.api.registerApmTaskProvider(message => assert.fail(message));
    const scriptTasks = await (optedIn.providers.tasks as typeof provider).provideTasks();
    assert.equal(scriptTasks.length, 5);
    const untrusted = harness(root, false);
    untrusted.api.registerApmTaskProvider(message => assert.fail(message));
    assert.equal((await (untrusted.providers.tasks as typeof provider).provideTasks()).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('task discovery refreshes cached manifests and retries failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-task-cache-'));
  const host = harness(root, true, true);
  const registration = host.api.registerApmTaskProvider(message => assert.fail(message));
  const provider = host.providers.tasks as { provideTasks(): Promise<{ definition: { script?: string } }[]> };
  const manifest = join(root, 'apm.yml');
  try {
    assert.equal((await provider.provideTasks()).length, 0);
    await writeFile(manifest, 'name: test\nscripts:\n  first: echo first\n');
    (host.providers.fileCreate as () => void)();
    assert.equal((await provider.provideTasks())[4].definition.script, 'first');
    await writeFile(manifest, 'name: test\nscripts:\n  second: echo second\n');
    (host.providers.fileChange as () => void)();
    assert.equal((await provider.provideTasks())[4].definition.script, 'second');
    await unlink(manifest);
    (host.providers.fileDelete as () => void)();
    assert.equal((await provider.provideTasks()).length, 0);
    await writeFile(manifest, 'scripts: [\n');
    (host.providers.fileCreate as () => void)();
    await assert.rejects(provider.provideTasks(), /Cannot discover APM scripts/);
    await writeFile(manifest, 'name: recovered\n');
    assert.equal((await provider.provideTasks()).length, 4, 'Failed discovery is not cached');
    (host.providers.fileChange as () => void)();
    const obsolete = provider.provideTasks();
    (host.providers.fileChange as () => void)();
    const current = provider.provideTasks();
    assert.notEqual(current, obsolete, 'Changes invalidate even pending requests');
    await Promise.all([obsolete, current]);
    assert.equal(provider.provideTasks(), current, 'Obsolete completion does not replace newer discovery');
  } finally { registration.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('manifest assistance uses YAML ranges and does not select a contract', () => {
  const host = harness('/project');
  const working = host.api.manifestContext('name: test\nversion: 1.0.0\n# preserve this\nx-custom: value\n');
  assert.equal(working.schema, undefined);
  assert.equal(working.errors.length, 0);
  const explicit = host.api.manifestContext('$schema: https://example.test/unknown\nname: test\n');
  assert.equal(explicit.schema, 'https://example.test/unknown');
  assert.equal(host.api.manifestContext('name: [\n').errors.length, 1);
  const registration = host.api.registerManifestAssistance({ async details() {} });
  const provider = host.providers.completions as { provideCompletionItems(document: { uri: Uri; getText(): string; lineAt(line: number): { text: string } }, position: { line: number; character: number }): { label: string }[] };
  const document = (text: string) => ({ uri: Uri.file('/project/apm.yml'), getText: () => text, lineAt: (line: number) => ({ text: text.split('\n')[line] }) });
  const targets = provider.provideCompletionItems(document('targets:\n  - co'), { line: 1, character: 6 });
  assert.ok(targets.some(item => item.label === 'copilot'));
  const dependencies = provider.provideCompletionItems(document('targets:\n  - copilot\ndependencies:\n  apm:\n    - co'), { line: 4, character: 8 });
  assert.equal(dependencies.length, 0);
  assert.ok(provider.provideCompletionItems(document('des'), { line: 0, character: 3 }).some(item => item.label === 'description'));
  registration.dispose();
});

test('managed task streaming does not retain captured output and supports cancellation', async () => {
  const chunks: string[] = [];
  const client = new ApmClient({ executable: process.execPath, cwd: tmpdir(), onOutput: text => chunks.push(text) });
  const result = await client.execute(['-e', 'console.log("streamed")'], { timeoutMs: null, captureOutput: false });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.match(chunks.join(''), /streamed/);
  const controller = new AbortController();
  const pending = client.execute(['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: null, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test('prepared CLI answers preserve individual input lines and reject injected prompts', async () => {
  const client = new ApmClient({ executable: process.execPath, cwd: tmpdir() });
  const result = await client.execute(['-e', 'let text = ""; process.stdin.on("data", chunk => text += chunk); process.stdin.on("end", () => console.log(JSON.stringify(text)));'], {
    inputLines: ['project', '2.0.0', 'Description with: punctuation', 'Example Author', 'y']
  });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout), 'project\n2.0.0\nDescription with: punctuation\nExample Author\ny\n');
  for (const value of ['bad\nanswer', 'bad\ranswer', 'bad\0answer']) {
    await assert.rejects(client.execute([], { inputLines: [value] }), /line breaks or NUL/);
  }
  await assert.rejects(client.execute([], { inputLines: ['name'], onPrompt: async () => 'answer' }), /cannot combine/);
});
