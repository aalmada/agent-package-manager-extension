import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const run$ = promisify(execFile);

async function until(description: string, check: () => boolean | Promise<boolean>, timeoutMs = 180_000, details?: () => string | Promise<string>) {
  console.log(`[suite] waiting until ${description}`);
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${description}${details ? `: ${await details()}` : ''}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const apm = () => vscode.workspace.getConfiguration('apm');
const json = async (name: string): Promise<Record<string, unknown>> => {
  // Close these tiny fixture files within one turn so polling cannot hold a Windows rename open.
  try { return JSON.parse(readFileSync(join(homedir(), '.apm', name), 'utf8')) as Record<string, unknown>; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
};
const registered = async () => ((await json('marketplaces.json')).marketplaces as { name: string }[] | undefined ?? []).map(m => m.name);
async function marketplace(name: string) {
  const dir = join(homedir(), 'markets', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'marketplace.json'), JSON.stringify({ name, plugins: [] }));
  return dir;
}

async function createApmShim(home: string) {
  const path = join(home, 'apm-test-shim');
  await writeFile(path, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const home = process.env.APM_TEST_HOME;
const args = process.argv.slice(2);
async function run() {
  if (args[0] === 'marketplace' && args[1] === 'remove' && args[2] === 'second' && existsSync(join(home, 'fail-remove'))) {
    console.error('Simulated marketplace removal failure');
    process.exitCode = 1;
    return;
  }
  const slow = args[0] === 'marketplace' && args[1] === 'add' && args[args.indexOf('--name') + 1] === 'slow';
  if (slow) {
    writeFileSync(join(home, 'slow-started'), '');
    const deadline = Date.now() + 20000;
    while (!existsSync(join(home, 'slow-release'))) {
      if (Date.now() > deadline) throw new Error('Timed out waiting to release the test command');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const result = spawnSync(process.env.APM_TEST_EXECUTABLE, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (slow) writeFileSync(join(home, 'slow-finished'), '');
  process.exitCode = result.status === null ? 1 : result.status;
}
run().catch(error => { console.error(error); process.exitCode = 1; });
`);
  await chmod(path, 0o700);
  return path;
}

export async function run(): Promise<void> {
  console.log('[suite] starting isolated extension tests');
  try { await steps(); } catch (error) { console.error('[suite] FAILED', error); throw error; }
}

async function steps() {
  const home = process.env.APM_TEST_HOME;
  assert.ok(home, 'Test runner supplies an isolated APM home');
  assert.equal(homedir(), home, 'Extension host must not see the real home directory');
  const extension = vscode.extensions.getExtension('antao-almada.apm-package-manager');
  assert.ok(extension, 'Extension is installed in test host');
  const nativeFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(nativeFolder);
  const manifestUri = vscode.Uri.joinPath(nativeFolder.uri, 'apm.yml');
  const nativeManifest = await readFile(manifestUri.fsPath, 'utf8');
  assert.match(nativeManifest, /check: echo explicit-only/);
  await extension.activate();
  console.log('[suite] extension activated');
  assert.equal(apm().get('allowRemoteImages'), false);
  await apm().update('allowRemoteImages', true, vscode.ConfigurationTarget.Global);
  assert.equal(apm().get('allowRemoteImages'), true);
  await apm().update('allowRemoteImages', undefined, vscode.ConfigurationTarget.Global);
  assert.equal(apm().get('allowRemoteImages'), false);
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['apm.initialize', 'apm.previewCompile', 'apm.compile', 'apm.validate', 'apm.auditWorkspace', 'apm.targets', 'apm.doctor', 'apm.runScript']) assert.ok(commands.includes(command), command);
  assert.ok(!commands.includes('apm.getStarted'));
  for (const command of ['apm.tools', 'apm.previewInstall', 'apm.chooseScope', 'apm.policy']) assert.ok(!commands.includes(command), command);
  assert.equal(apm().get('tasks.includeScripts'), false);
  await vscode.commands.executeCommand('apm.refresh');
  assert.ok(commands.includes('apm.browser.focus'));
  await vscode.commands.executeCommand('apm.browser.focus');
  for (const section of ['catalog', 'installed', 'updates']) {
    assert.ok(commands.includes(`apm.views.${section}`), `Views menu command registered for ${section}`);
    assert.ok(commands.includes(`apm.views.${section}.checked`));
    await vscode.commands.executeCommand(`apm.views.${section}`);
    await vscode.commands.executeCommand(`apm.views.${section}.checked`);
  }
  await vscode.commands.executeCommand('apm.filter.dependencies');
  await vscode.commands.executeCommand('apm.filter.dependencies');
  await vscode.commands.executeCommand('apm.browser.focus');
  await mkdir(join(nativeFolder.uri.fsPath, '.apm', 'instructions'), { recursive: true });
  const instructionPath = join(nativeFolder.uri.fsPath, '.apm', 'instructions', 'test.instructions.md');
  await writeFile(instructionPath, '---\ndescription: Test instruction\napplyTo: "**"\n---\nReview the code.\n');
  await run$(process.env.APM_TEST_EXECUTABLE!, ['compile', '--validate'], { cwd: nativeFolder.uri.fsPath });
  let nativeTasks: vscode.Task[] = [];
  let discoveredTasks: vscode.Task[] = [];
  await until('APM tasks are discovered after the task system initializes', async () => {
    discoveredTasks = await vscode.tasks.fetchTasks({ type: 'apm' });
    nativeTasks = discoveredTasks.filter(task => task.scope === nativeFolder || typeof task.scope !== 'number' && task.scope?.uri.toString() === nativeFolder.uri.toString());
    return nativeTasks.length === 4;
  }, 30_000, async () => JSON.stringify({
    trusted: vscode.workspace.isTrusted, autoDetect: vscode.workspace.getConfiguration('task').get('autoDetect'),
    manifest: await readFile(manifestUri.fsPath, 'utf8'),
    folder: nativeFolder.uri.toString(),
    tasks: discoveredTasks.map(task => ({ definition: task.definition, scope: typeof task.scope === 'number' ? task.scope : task.scope?.uri.toString() }))
  }));
  assert.deepEqual(nativeTasks.map(task => task.definition.workflow).sort(), ['audit', 'compile', 'validate', 'watch']);
  const validationTask = nativeTasks.find(task => task.definition.workflow === 'validate');
  assert.ok(validationTask);
  let taskFinished = false;
  let taskExitCode: number | undefined;
  const taskEnd = vscode.tasks.onDidEndTask(event => { if (event.execution.task.definition.workflow === 'validate') taskFinished = true; });
  const taskProcessEnd = vscode.tasks.onDidEndTaskProcess(event => { if (event.execution.task.definition.workflow === 'validate') taskExitCode = event.exitCode; });
  try {
    await vscode.tasks.executeTask(validationTask);
    await until('the native validation task completes', () => taskFinished);
    assert.equal(taskExitCode, 0, 'Native validation task succeeds, not merely terminates');
    assert.equal(await readFile(manifestUri.fsPath, 'utf8'), nativeManifest);
  } finally { taskEnd.dispose(); taskProcessEnd.dispose(); }
  await vscode.commands.executeCommand('apm.validate', manifestUri);
  assert.ok(!vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.label === 'APM Tools'));
  await vscode.commands.executeCommand('apm.previewCompile', manifestUri);
  const previewDocument = vscode.workspace.textDocuments.find(document => document.uri.scheme === 'apm-result');
  assert.ok(previewDocument, 'Compilation preview uses the native read-only document provider');
  assert.match(previewDocument.getText(), /Compilation preview/);
  assert.equal(previewDocument.isDirty, false);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  const manifestDocument = await vscode.workspace.openTextDocument(manifestUri);
  const manifestEditor = await vscode.window.showTextDocument(manifestDocument);
  const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', manifestUri, new vscode.Position(0, 1));
  assert.ok(hover?.length, 'Manifest editor provides local APM field help');
  assert.equal(manifestEditor.document.isDirty, false);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await unlink(manifestUri.fsPath);
  await unlink(instructionPath);
  for (const command of ['apm.refresh', 'apm.marketplaces', 'apm.settings', 'apm.install', 'apm.setup', 'apm.dependencies.refresh', 'apm.dependencies.why', 'apm.dependencies.find', 'apm.policy.review', 'apm.policy.explain', 'apm.policy.manage', 'apm.filter.installed', 'apm.filter.updates', 'apm.filter.scope.all', 'apm.filter.scope.workspace', 'apm.filter.scope.global', 'apm.filter.marketplace.all', 'apm.filter.marketplace.choose', 'apm.filter.sort.name']) assert.ok(commands.includes(command), command);
  assert.ok(!commands.includes('apm.filter.sort.version'));
  assert.ok(!commands.includes('apm.filter.sort.version-desc'));

  // Settings editor, not a custom page.
  await vscode.commands.executeCommand('apm.marketplaces');
  await until('the native Settings editor opens', () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Settings', 10_000);
  assert.ok(!vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.label === 'APM Marketplaces'));
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await vscode.commands.executeCommand('apm.settings');
  await until('the extension Settings editor opens', () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'Settings', 10_000);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // CLI state → settings on startup.
  const seeded = pathToFileURL(join(home, 'markets', 'seeded')).href;
  const legacy = `legacy-alias=${join(home, 'markets', 'legacy')}`;
  await until('registered marketplaces are imported', () => apm().get<string[]>('marketplaces', []).includes(seeded), 180_000,
    async () => JSON.stringify({ settings: apm().get<string[]>('marketplaces', []), registry: await json('marketplaces.json') }));
  await until('CLI config is imported', () => apm().get('config.autoIntegrate') === false);
  await until('legacy marketplace declarations are migrated', async () =>
    apm().get<string[]>('marketplaces', []).includes(legacy) && (await registered()).includes('legacy-alias'));
  assert.equal(apm().inspect('marketplaceEntries')?.globalValue, undefined);
  assert.deepEqual(apm().get<string[]>('marketplaces', []).sort(), [seeded, legacy].sort(), 'The test host uses only local marketplaces');
  await until('an explicit setting wins on first synchronization', async () => (await json('config.json')).prefer_ssh === true);

  // Settings → CLI: add, then remove an item.
  const second = pathToFileURL(await marketplace('second')).href;
  await apm().update('marketplaces', [seeded, legacy, second], vscode.ConfigurationTarget.Global);
  await until('a new setting item is registered', async () => (await registered()).includes('second'));
  await apm().update('marketplaces', [legacy, second], vscode.ConfigurationTarget.Global);
  await until('a deleted setting item is unregistered', async () => !(await registered()).includes('seeded'));

  // An unsuccessful replacement must not delete its previous registration.
  const badReplacement = `second=${pathToFileURL(join(home, 'missing-marketplace')).href}`;
  await apm().update('marketplaces', [legacy, badReplacement], vscode.ConfigurationTarget.Global);
  await until('a failed replacement retains the original item', async () =>
    apm().get<string[]>('marketplaces', []).includes(second) && (await registered()).includes('second'));
  await apm().update('marketplaces', [legacy, second], vscode.ConfigurationTarget.Global);

  // A local manifest's default alias must not overwrite an unrelated registration.
  const collision = await marketplace('collision');
  await writeFile(join(collision, 'marketplace.json'), JSON.stringify({ name: 'second', plugins: [] }));
  const collisionEntry = pathToFileURL(collision).href;
  await apm().update('marketplaces', [legacy, second, collisionEntry], vscode.ConfigurationTarget.Global);
  await until('a collision-safe marketplace alias is registered', async () => (await registered()).includes('collision'), 180_000,
    async () => JSON.stringify({ settings: apm().get<string[]>('marketplaces', []), registry: await json('marketplaces.json') }));
  assert.ok((await registered()).includes('second'));

  // Relative paths are resolved once against the single workspace folder.
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspace, 'Test host opened one local workspace');
  await mkdir(join(workspace, 'vendor'), { recursive: true });
  await writeFile(join(workspace, 'vendor', 'marketplace.json'), JSON.stringify({ name: 'vendor', plugins: [] }));
  const relative = `local=./vendor`, resolved = `local=${pathToFileURL(join(workspace, 'vendor')).href}`;
  await apm().update('marketplaces', [legacy, second, collisionEntry, relative], vscode.ConfigurationTarget.Global);
  await until('a relative marketplace is registered and made absolute', async () =>
    apm().get<string[]>('marketplaces', []).includes(resolved) && (await registered()).includes('local'));

  const executable = apm().get<string>('executablePath', 'apm');
  if (process.platform !== 'win32') {
    const shim = await createApmShim(home);
    await apm().update('executablePath', shim, vscode.ConfigurationTarget.Global);
    await writeFile(join(home, 'fail-remove'), '');
    await apm().update('marketplaces', [legacy, collisionEntry, resolved], vscode.ConfigurationTarget.Global);
    await until('a failed removal restores its setting and keeps the registration', async () =>
      apm().get<string[]>('marketplaces', []).includes(second) && (await registered()).includes('second'));
    await unlink(join(home, 'fail-remove'));

    const slow = `slow=${pathToFileURL(await marketplace('slow')).href}`;
    await apm().update('marketplaces', [legacy, slow, collisionEntry, resolved], vscode.ConfigurationTarget.Global);
    await until('a delayed registration starts', () => existsSync(join(home, 'slow-started')));
    await apm().update('marketplaces', [legacy, second, collisionEntry, resolved], vscode.ConfigurationTarget.Global);
    await writeFile(join(home, 'slow-release'), '');
    await until('the delayed registration finishes', () => existsSync(join(home, 'slow-finished')));
    await until('a concurrent setting edit wins without losing the original registration', async () => {
      const names = await registered();
      const entries = apm().get<string[]>('marketplaces', []);
      return names.includes('second') && !names.includes('slow') && entries.includes(second) && !entries.includes(slow);
    });
    await apm().update('executablePath', executable, vscode.ConfigurationTarget.Global);
  }

  // CLI → settings: registrations made outside VS Code.
  await run$(executable, ['marketplace', 'add', await marketplace('third')], { env: process.env });
  const third = pathToFileURL(join(home, 'markets', 'third')).href;
  await until('an external registration appears in settings', () => apm().get<string[]>('marketplaces', []).includes(third), 180_000,
    async () => JSON.stringify({ expected: third, settings: apm().get<string[]>('marketplaces', []), registered: await registered() }));
  await run$(executable, ['marketplace', 'remove', 'second', '--yes'], { env: process.env });
  await until('an external removal disappears from settings', () => !apm().get<string[]>('marketplaces', []).includes(second));

  // CLI configuration both ways, including rejection.
  await apm().update('config.preferSsh', true, vscode.ConfigurationTarget.Global);
  await apm().update('config.target', ['vscode', 'claude'], vscode.ConfigurationTarget.Global);
  await until('settings are written to APM config', async () => {
    const config = await json('config.json');
    return config.prefer_ssh === true && JSON.stringify(config.install_target) === JSON.stringify(['vscode', 'claude']);
  });
  await apm().update('config.tempDir', join(home, 'missing'), vscode.ConfigurationTarget.Global);
  await until('a value APM rejects is reverted', () => apm().get('config.tempDir') === '');
  await run$(executable, ['config', 'set', 'auto-integrate', 'true'], { env: process.env });
  await until('an external config change appears in settings', () => apm().get('config.autoIntegrate') === true);

  assert.ok(!vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.label === 'APM Tools'));
  console.log('APM extension integration tests passed.');
}
