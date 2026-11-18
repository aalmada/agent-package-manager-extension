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
import { parseDocument } from 'yaml';
import { yamlCompletion, yamlDefinition, yamlHover, yamlIssues } from '../../src/apm/yamlAssistance';

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
class Range {
  readonly startLine: number; readonly startCharacter: number; readonly endLine: number; readonly endCharacter: number;
  constructor(start: number | { line: number; character: number }, end: number | { line: number; character: number }, endLine?: number, endCharacter?: number) {
    this.startLine = typeof start === 'number' ? start : start.line;
    this.startCharacter = typeof start === 'number' && typeof end === 'number' ? end : typeof start === 'number' ? 0 : start.character;
    this.endLine = typeof end === 'number' ? endLine ?? this.startLine : end.line;
    this.endCharacter = typeof end === 'number' ? endCharacter ?? this.startCharacter : end.character;
  }
}
class CodeLens { command?: { title: string; command: string; arguments?: unknown[] }; constructor(readonly range: Range) {} }
class Diagnostic {
  source?: string; code?: string;
  constructor(readonly range: Range, readonly message: string, readonly severity: number) {}
}
const disposable = () => ({ dispose() {} });
function yamlDocument(text: string, name = 'apm.yml') {
  return {
    uri: Uri.file(`/project/${name}`), eol: 1, getText: () => text,
    lineAt: (line: number) => ({ lineNumber: line, text: text.split('\n')[line] }),
    offsetAt: (position: { line: number; character: number }) => text.split('\n').slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) + position.character,
    positionAt: (offset: number) => {
      const lines = text.slice(0, offset).split('\n');
      return { line: lines.length - 1, character: lines.at(-1)!.length };
    }
  };
}
type Native = typeof import('../../src/navigation') & typeof import('../../src/manifestAssistance') & typeof import('../../src/taskProvider');
function harness(root: string, trusted = true, includeScripts = false) {
  const diagnostics = new Map<string, Diagnostic[]>();
  const providers: Record<string, unknown> = {};
  const folder = { name: 'project', uri: Uri.file(root), index: 0 };
  class Task {
    constructor(readonly definition: object, readonly scope: object, readonly name: string, readonly source: string, readonly execution: object) {}
  }
  const vscode = {
    authentication: { getSession: async () => undefined },
    Uri, Range, CodeLens, Diagnostic, DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 }, EndOfLine: { LF: 1, CRLF: 2 },
    RelativePattern: class { constructor(readonly root: Uri, readonly pattern: string) {} },
    EventEmitter: class { event = () => disposable(); fire() {} dispose() {} },
    Task, CustomExecution: class { constructor(readonly callback: () => Promise<object>) {} },
    TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 2 },
    workspace: {
      isTrusted: trusted, workspaceFolders: [folder], textDocuments: [],
      getConfiguration: () => ({ get: (_name: string, fallback: unknown) => _name === 'tasks.includeScripts' ? includeScripts : fallback }),
      openTextDocument: async () => providers.manifest,
      applyEdit: async (edit: object) => { providers.appliedEdit = edit; return true; },
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
      onDidOpenTextDocument: (listener: object) => { providers.documentOpen = listener; return disposable(); },
      onDidCloseTextDocument: (listener: object) => { providers.documentClose = listener; return disposable(); }
    },
    languages: {
      createDiagnosticCollection: () => ({
        has: (uri: Uri) => diagnostics.has(uri.toString()), clear: () => diagnostics.clear(), dispose() {},
        delete: (uri: Uri) => diagnostics.delete(uri.toString()),
        set: (uri: Uri, values: Diagnostic[]) => diagnostics.set(uri.toString(), values)
      }),
      registerCodeActionsProvider: (_selector: unknown, provider: object) => { providers.actions = provider; return disposable(); },
      registerCompletionItemProvider: (selector: unknown, provider: object) => { providers.completions = provider; providers.completionSelector = selector; return disposable(); },
      registerCodeLensProvider: (_selector: unknown, provider: object) => { providers.codeLenses = provider; return disposable(); },
      registerHoverProvider: (_selector: unknown, provider: object) => { providers.hovers = provider; return disposable(); },
      registerDocumentLinkProvider: (_selector: unknown, provider: object) => { providers.links = provider; return disposable(); }
    },
    tasks: { registerTaskProvider: (_type: string, provider: object) => { providers.tasks = provider; return disposable(); } },
    extensions: { getExtension: () => providers.yamlActive ? { isActive: true } : undefined },
    commands: { registerCommand: (id: string, callback: (...args: unknown[]) => unknown) => {
      const commands = (providers.commands ??= {}) as Record<string, (...args: unknown[]) => unknown>;
      commands[id] = callback;
      return disposable();
    } },
    window: { showQuickPick: async (items: { label: string }[], options: { canPickMany?: boolean }) => {
      providers.quickPick = { items, options };
      return options.canPickMany ? items.filter(item => item.label === providers.selectedTarget) : undefined;
    } },
    WorkspaceEdit: class { replace(uri: Uri, range: Range, text: string) { providers.edit = { uri, range, text }; } },
    Disposable: { from: (...items: { dispose(): void }[]) => ({ dispose() { for (const item of items) item.dispose(); } }) },
    CompletionItemKind: { Property: 1, EnumMember: 2 }, CodeActionKind: { Source: 'source', QuickFix: 'quickfix' },
    CompletionItem: class { constructor(readonly label: string) {} },
    Hover: class { constructor(readonly contents: string, readonly range: Range) {} },
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
  assert.deepEqual(parseMessage({ type: 'back' }), { type: 'back' });
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

test('manifest assistance uses YAML ranges and does not select a contract', async () => {
  const host = harness('/project');
  const working = host.api.manifestContext('name: test\nversion: 1.0.0\n# preserve this\nx-custom: value\n');
  assert.equal(working.schema, undefined);
  assert.equal(working.errors.length, 0);
  const explicit = host.api.manifestContext('$schema: https://example.test/unknown\nname: test\n');
  assert.equal(explicit.schema, 'https://example.test/unknown');
  assert.equal(host.api.manifestContext('name: [\n').errors.length, 1);
  const registration = host.api.registerManifestAssistance({ async details() {} });
  const provider = host.providers.completions as { provideCompletionItems(doc: ReturnType<typeof yamlDocument>, position: { line: number; character: number }): { label: string }[] };
  const document = yamlDocument;
  const targets = provider.provideCompletionItems(document('targets:\n  - co'), { line: 1, character: 6 });
  assert.ok(targets.some(item => item.label === 'copilot'));
  const dependencies = provider.provideCompletionItems(document('targets:\n  - copilot\ndependencies:\n  apm:\n    - co'), { line: 4, character: 8 });
  assert.equal(dependencies.length, 0);
  assert.ok(provider.provideCompletionItems(document('des'), { line: 0, character: 3 }).some(item => item.label === 'description'));
  const manifest = document('# project settings\ntargets:\n  - copilot\ndependencies:\n  apm: []\n');
  host.providers.manifest = manifest;
  const lenses = host.providers.codeLenses as { provideCodeLenses(doc: ReturnType<typeof document>): { command?: { title: string; command: string; arguments?: unknown[] } }[] };
  const lens = lenses.provideCodeLenses(manifest)[0];
  assert.equal(lens.command?.title, 'Select deployment targets (1 selected)');
  assert.equal(lens.command?.command, 'apm.selectManifestTargets');
  const commands = host.providers.commands as Record<string, (uri: Uri) => Promise<void>>;
  host.providers.selectedTarget = 'claude';
  await commands['apm.selectManifestTargets'](manifest.uri);
  const edit = host.providers.edit as { range: Range; text: string };
  assert.ok(host.providers.appliedEdit);
  assert.equal(edit.range.startLine, 1, 'The edit leaves comments preceding the targets field untouched');
  assert.equal(edit.text, 'targets:\n  - claude\n');
  assert.ok((host.providers.quickPick as { items: { label: string }[] }).items.some(item => item.label === 'copilot'));
  host.providers.selectedTarget = '';
  await commands['apm.selectManifestTargets'](manifest.uri);
  assert.equal((host.providers.edit as { text: string }).text, '', 'Clearing the selection removes the explicit targets field');
  registration.dispose();
});

test('YAML completion follows nested mappings, object dependencies and scalar values in both formats', () => {
  const manifest = yamlDefinition(false, ['copilot', 'claude']);
  const completion = (text: string, lock = false) => yamlCompletion(text, text.length, lock ? yamlDefinition(true) : manifest);
  assert.ok(completion('compilation:\n  ')?.field.fields?.strategy);
  assert.ok(completion('dependencies:\n  ')?.field.fields?.mcp);
  assert.ok(completion('devDependencies:\n  apm:\n  - git: owner/repo\n    ')?.field.fields?.ref);
  assert.ok(completion('dependencies:\n  mcp:\n    - ')?.field.fields?.transport);
  assert.deepEqual(completion('dependencies:\n  mcp:\n    - name: example\n      transport: ')?.field.values, ['stdio', 'sse', 'http', 'streamable-http']);
  assert.deepEqual(completion('targets: [co')?.field.values, ['copilot', 'claude']);
  assert.deepEqual(completion('targets:\n- cl')?.field.values, ['copilot', 'claude']);
  assert.deepEqual(completion('compilation:\n  resolve_links: ')?.field.types, ['boolean']);
  assert.ok(completion('dep', true)?.field.fields?.dependencies);
  assert.ok(completion('dependencies:\n- repo_url: owner/repo\n  ', true)?.field.fields?.resolved_commit);
  assert.deepEqual(completion('dependencies:\n- is_dev: ', true)?.field.types, ['boolean']);
  assert.equal(completion('scripts:\n  custom: ')?.field.description, 'String value.');
  for (const text of ['# comment', 'description: |\n  ordinary text', 'x-custom:\n  ', 'dependencies:\n  apm:\n    - owner/repo']) {
    assert.equal(completion(text)?.field.fields, undefined, text);
  }
  const duplicate = completion('name: test\nversion: 1.0.0\n');
  assert.ok(duplicate?.keys?.includes('name'));
  const crlf = completion('compilation:\r\n  stra');
  assert.ok(crlf?.field.fields?.strategy);
});

test('local YAML validation checks structures, values and exact ranges without closing extension points', () => {
  const manifest = yamlDefinition(false);
  const text = 'name: test\nversion: 1.0.0\ncompilation:\n  strategy: invalid\n  resolve_links: yes\ndependencies:\n  apm: wrong\n';
  const issues = yamlIssues(parseDocument(text), manifest);
  assert.equal(issues.length, 3);
  assert.equal(text.slice(issues[0].start, issues[0].end), 'invalid');
  assert.match(issues[0].message, /distributed, single-file/);
  assert.match(issues[1].message, /boolean/);
  assert.match(issues[2].message, /sequence/);
  assert.match(yamlIssues(parseDocument('name: example'), manifest)[0].message, /requires version/);
  assert.match(yamlIssues(parseDocument('- example'), manifest)[0].message, /mapping/);
  assert.equal(yamlIssues(parseDocument('name: test\nversion: 1.0.0\nx-custom: [anything]\nnew_field: true\nincludes: [src]\ntargets: copilot\n'), manifest).length, 0);
  const lock = yamlDefinition(true);
  assert.equal(yamlIssues(parseDocument("lockfile_version: '1'\ndependencies:\n- repo_url: owner/repo\n  resolved_commit: abc\n  is_dev: false\n  deployed_files: [file.md]\n  future_field: {anything: true}\n"), lock).length, 0);
  const invalid = yamlIssues(parseDocument('lockfile_version: 1\ndependencies:\n- is_dev: yes\n  deployed_files: [123]\n'), lock);
  assert.equal(invalid.length, 3);
  assert.match(invalid[0].message, /lockfile_version.*string/);
  assert.match(invalid[2].message, /deployed_files\[0\].*string/);
  const hoverText = 'dependencies:\n- repo_url: owner/repo\n  resolved_commit: abc\n';
  assert.match(yamlHover(parseDocument(hoverText), hoverText.indexOf('resolved_commit'), lock)!.field.description, /Exact resolved Git commit/);
  const valueText = 'name: resolved_commit\nversion: 1.0.0\n';
  assert.equal(yamlHover(parseDocument(valueText), valueText.indexOf('resolved_commit'), manifest), undefined);
});

test('YAML completion replaces whole tokens and preserves colons, quotes and flow collections', () => {
  const definition = yamlDefinition(false, ['copilot', 'claude']);
  for (const marked of [
    'compilation:\n  stra|tegy: single-file\n',
    'compilation: { stra|tegy: single-file }\n',
    "compilation:\n  'stra|tegy': single-file\n"
  ]) {
    const offset = marked.indexOf('|'), text = marked.replace('|', '');
    const context = yamlCompletion(text, offset, definition)!;
    assert.ok(context.field.fields?.strategy, marked);
    assert.equal(text.slice(context.start, context.end), 'strategy', marked);
    assert.equal(context.hasColon, true, marked);
    assert.ok(!context.keys?.includes('strategy'), marked);
  }
  for (const [marked, token, value] of [
    ['compilation: { strategy: "si|ngle-file" }', 'single-file', 'single-file'],
    ['compilation:\n  strategy: "|', '', 'single-file'],
    ["compilation:\n  strategy: '|", '', 'single-file'],
    ["includes: 'au|to'", 'auto', 'auto'],
    ['targets: [co|pilot]', 'copilot', 'copilot'],
    ['dependencies:\n  mcp:\n  - name: test\n    transport: "st|dio"', 'stdio', 'stdio'],
    ['compilation:\n  resolve_links: fa|lse', 'false', undefined]
  ] as const) {
    const offset = marked.indexOf('|'), text = marked.replace('|', '');
    const context = yamlCompletion(text, offset, definition)!;
    assert.equal(text.slice(context.start, context.end), token, marked);
    if (value) assert.ok(context.field.values?.includes(value), marked);
    else assert.ok(context.field.types?.includes('boolean'), marked);
  }
  for (const marked of ['compilation: { | }', 'compilation: { strategy: distributed, | }']) {
    const context = yamlCompletion(marked.replace('|', ''), marked.indexOf('|'), definition);
    assert.ok(context?.field.fields?.resolve_links, marked);
  }
});

test('empty YAML values and missing fields have visible, focused diagnostic ranges', () => {
  for (const [text, token, message] of [
    ['name: test\nversion: 1.0.0\ncompilation:\n  strategy:\n', 'strategy', /strategy must be/],
    ['name: test\nversion: 1.0.0\ndependencies:\n', 'dependencies', /dependencies must be/],
    ['name: test\n', 'name', /requires version/],
    ['name: test\nversion: 1.0.0\ndependencies:\n  mcp:\n  - command: example\n', 'command', /requires name/]
  ] as const) {
    const issues = yamlIssues(parseDocument(text), yamlDefinition(false));
    const issue = issues.find(issue => message.test(issue.message));
    assert.ok(issue, text);
    assert.equal(text.slice(issue.start, issue.end), token, text);
  }
  const text = 'dependencies:\n- is_dev:\n';
  const issue = yamlIssues(parseDocument(text), yamlDefinition(true))[0];
  assert.equal(text.slice(issue.start, issue.end), 'is_dev');
});

test('YAML providers preserve existing values, insert structured snippets and underline empty values', () => {
  const host = harness('/project');
  host.api.registerManifestAssistance({ async details() {} });
  const provider = host.providers.completions as {
    provideCompletionItems(document: ReturnType<typeof yamlDocument>, position: { line: number; character: number }): {
      label: string; insertText?: { value: string }; range: Range;
    }[];
  };
  const document = yamlDocument('compilation:\n  strategy: single-file\n');
  const item = provider.provideCompletionItems(document, { line: 1, character: 6 }).find(item => item.label === 'strategy')!;
  assert.ok(item);
  assert.equal(item.insertText?.value, 'strategy', 'Replacing a key must not insert another colon or overwrite its value');
  assert.equal(item.range.startCharacter, 2);
  assert.equal(item.range.endCharacter, 10, 'Replacement covers the full key, not only its prefix');
  const root = yamlDocument('');
  const items = provider.provideCompletionItems(root, root.positionAt(0));
  const expand = (snippet: string, value: string) => snippet.replace('$0', value);
  const mapping = items.find(item => item.label === 'compilation')?.insertText?.value ?? '';
  assert.doesNotMatch(mapping, /\t/, 'YAML indentation must use spaces');
  assert.deepEqual(parseDocument(expand(mapping, 'strategy: distributed')).toJS(), { compilation: { strategy: 'distributed' } });
  const lock = yamlDocument('', 'apm.lock.yaml');
  const lockItems = provider.provideCompletionItems(lock, lock.positionAt(0));
  const sequence = lockItems.find(item => item.label === 'dependencies')?.insertText?.value ?? '';
  assert.doesNotMatch(sequence, /\t/, 'YAML indentation must use spaces');
  assert.deepEqual(parseDocument(expand(sequence, 'repo_url: owner/repo')).toJS(), { dependencies: [{ repo_url: 'owner/repo' }] });
  const quotedBoolean = yamlDocument('compilation:\n  resolve_links: "fa"\n');
  const boolean = provider.provideCompletionItems(quotedBoolean, { line: 1, character: 20 }).find(item => item.label === 'false')!;
  assert.ok(boolean);
  const line = quotedBoolean.lineAt(1).text;
  assert.equal(line.slice(0, boolean.range.startCharacter) + boolean.label + line.slice(boolean.range.endCharacter), '  resolve_links: false');
  const invalid = yamlDocument('dependencies:\n- is_dev:\n', 'apm.lock.yaml');
  (host.providers.documentOpen as (document: ReturnType<typeof yamlDocument>) => void)(invalid);
  const diagnostic = host.diagnostics.get(invalid.uri.toString())![0];
  assert.equal(diagnostic.severity, 0, 'Errors produce editor squiggles');
  assert.equal(diagnostic.range.startLine, 1);
  assert.equal(diagnostic.range.startCharacter, 2);
  assert.equal(diagnostic.range.endCharacter, 8);
});

test('both YAML providers publish live diagnostics, defer explicit contracts and clean up on close', () => {
  const host = harness('/project');
  host.api.registerManifestAssistance({ async details() {} });
  assert.ok((host.providers.completionSelector as { pattern: string }[]).some(selector => selector.pattern.endsWith('/apm.lock.yaml')));
  const change = host.providers.documentChange as (event: { document: ReturnType<typeof yamlDocument> }) => void;
  const open = host.providers.documentOpen as (document: ReturnType<typeof yamlDocument>) => void;
  const close = host.providers.documentClose as typeof open;
  const lock = yamlDocument('dependencies:\n- is_dev: incorrect\n', 'apm.lock.yaml');
  open(lock);
  assert.match(host.diagnostics.get(lock.uri.toString())![0].message, /is_dev.*boolean/);
  change({ document: yamlDocument('dependencies: []\n', 'apm.lock.yaml') });
  assert.equal(host.diagnostics.get(lock.uri.toString())!.length, 0);
  change({ document: yamlDocument('dependencies: [\n', 'apm.lock.yaml') });
  assert.ok(host.diagnostics.get(lock.uri.toString())!.some(item => item.source === 'APM YAML syntax'));
  host.providers.yamlActive = true;
  change({ document: lock });
  assert.equal(host.diagnostics.get(lock.uri.toString())!.length, 1, 'YAML extension does not suppress APM structural checks');
  const explicit = yamlDocument('$schema: https://example.test/contract\ndependencies: wrong\n', 'apm.lock.yaml');
  change({ document: explicit });
  assert.equal(host.diagnostics.get(lock.uri.toString())!.length, 1);
  assert.equal(host.diagnostics.get(lock.uri.toString())![0].source, 'APM contract');
  const completions = host.providers.completions as { provideCompletionItems(doc: ReturnType<typeof yamlDocument>, position: { line: number; character: number }): { label: string }[] };
  assert.equal(completions.provideCompletionItems(explicit, explicit.positionAt(explicit.getText().length)).length, 0);
  const booleanDoc = yamlDocument('dependencies:\n- is_dev: ', 'apm.lock.yaml');
  assert.deepEqual(Array.from(completions.provideCompletionItems(booleanDoc, booleanDoc.positionAt(booleanDoc.getText().length)), item => item.label), ['true', 'false']);
  close(lock);
  assert.equal(host.diagnostics.has(lock.uri.toString()), false);
  open(yamlDocument('dependencies: wrong\n', 'other.yaml'));
  assert.equal(host.diagnostics.size, 0, 'Unrelated YAML documents are ignored');
  const untrusted = harness('/project', false);
  untrusted.api.registerManifestAssistance({ async details() {} });
  (untrusted.providers.documentOpen as typeof open)(lock);
  assert.equal(untrusted.diagnostics.size, 0);
});

test('YAML hover limits contract notes to the $schema field', () => {
  const host = harness('/project');
  host.api.registerManifestAssistance({ async details() {} });
  const hovers = host.providers.hovers as {
    provideHover(document: ReturnType<typeof yamlDocument>, position: { line: number; character: number }): { contents: string } | undefined;
  };
  const plain = yamlDocument('name: test\nversion: 1.0.0\n');
  const nameHover = hovers.provideHover(plain, plain.positionAt(plain.getText().indexOf('name')));
  assert.ok(nameHover);
  assert.doesNotMatch(nameHover.contents, /working-draft|Explicit contract/);

  const manifest = yamlDocument('$schema: https://example.test/contract\nname: test\n');
  const schemaHover = hovers.provideHover(manifest, manifest.positionAt(manifest.getText().indexOf('$schema')));
  assert.ok(schemaHover);
  assert.match(schemaHover.contents, /Explicit contract/);
  const manifestNameHover = hovers.provideHover(manifest, manifest.positionAt(manifest.getText().indexOf('name')));
  assert.ok(manifestNameHover);
  assert.doesNotMatch(manifestNameHover.contents, /working-draft|Explicit contract/);

  const draft = yamlDocument('$schema:\nname: test\n');
  const draftSchemaHover = hovers.provideHover(draft, draft.positionAt(draft.getText().indexOf('$schema')));
  assert.ok(draftSchemaHover);
  assert.match(draftSchemaHover.contents, /Local APM working-draft assistance/);
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
