import * as vscode from 'vscode';
import { parseDocument } from 'yaml';
import { ApmClient } from './apm/client';
import { readProjectManifest } from './apm/manifest';
import { record } from './apm/adapters';
import { redact } from './apm/redact';
import { githubEnvironment } from './authentication';

const commands = {
  compile: ['compile'], watch: ['compile', '--watch'], validate: ['compile', '--validate'], audit: ['audit', '--ci']
} as const;
export interface ApmTaskDefinition extends vscode.TaskDefinition { type: 'apm'; workflow: keyof typeof commands | 'script'; script?: string }
export function taskArguments(definition: ApmTaskDefinition): string[] {
  if (definition.workflow === 'script') {
    if (!definition.script || !/^[\w][\w .:-]{0,127}$/.test(definition.script)) throw new Error('An APM script task requires a valid manifest script name.');
    return ['run', definition.script];
  }
  if (!Object.hasOwn(commands, definition.workflow)) throw new Error('Unknown APM task workflow.');
  if (definition.script !== undefined) throw new Error('Only script tasks accept a script name.');
  return [...commands[definition.workflow]];
}

export function registerApmTaskProvider(report: (message: string) => void,
  serialize: <T>(operation: () => Promise<T>) => Promise<T> = operation => operation(),
  environment: (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<Record<string, string>> = githubEnvironment): vscode.Disposable {
  const active = new Set<AbortController>();
  const runScript = async (executable: string, args: string[], folder: vscode.WorkspaceFolder, signal: AbortSignal): Promise<number> => {
    const env = await environment(args, folder.uri.fsPath, signal);
    if (!vscode.workspace.isTrusted) throw new Error('Workspace Trust changed before task execution.');
    if (signal.aborted) return 130;
    const task = new vscode.Task({ type: 'apm-script-run' }, folder, `run ${args[1]}`, 'APM', new vscode.ProcessExecution(executable, args, { cwd: folder.uri.fsPath, env }), []);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: true, panel: vscode.TaskPanelKind.Dedicated };
    return new Promise<number>((resolve, reject) => {
      let execution: vscode.TaskExecution | undefined, settled = false;
      const pending: [vscode.TaskExecution, number | undefined][] = [];
      const cleanup = () => { process.dispose(); end.dispose(); signal.removeEventListener('abort', stop); };
      const finish = (candidate: vscode.TaskExecution, code: number | undefined) => {
        if (!execution) { pending.push([candidate, code]); return; }
        if (candidate !== execution || settled) return;
        settled = true; cleanup(); resolve(signal.aborted ? 130 : code ?? 1);
      };
      const process = vscode.tasks.onDidEndTaskProcess(event => finish(event.execution, event.exitCode));
      const end = vscode.tasks.onDidEndTask(event => finish(event.execution, undefined));
      const stop = () => execution?.terminate();
      signal.addEventListener('abort', stop, { once: true });
      void vscode.tasks.executeTask(task).then(result => {
        execution = result;
        if (signal.aborted) execution.terminate();
        for (const [candidate, code] of pending) finish(candidate, code);
      }, error => { cleanup(); reject(error); });
    });
  };
  const create = (definition: ApmTaskDefinition, folder: vscode.WorkspaceFolder) => {
    const args = taskArguments(definition);
    const execution = new vscode.CustomExecution(async () => {
      const write = new vscode.EventEmitter<string>(), close = new vscode.EventEmitter<number>();
      const controller = new AbortController();
      active.add(controller);
      return {
        onDidWrite: write.event, onDidClose: close.event,
        open: () => {
          void (async () => {
            try {
              if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running APM tasks.');
              const settings = vscode.workspace.getConfiguration('apm', folder.uri);
              let scriptManifest: string | undefined;
              if (definition.workflow === 'script') {
                if (!settings.get<boolean>('tasks.includeScripts', false)) throw new Error('Enable apm.tasks.includeScripts explicitly before running project scripts.');
                const text = await readProjectManifest(folder.uri.fsPath);
                scriptManifest = text;
                const manifest: unknown = text === undefined ? undefined : parseDocument(text).toJS();
                const scripts = record(manifest) ? manifest.scripts : undefined;
                if (!record(scripts) || typeof scripts[definition.script!] !== 'string') throw new Error('This script no longer exists in apm.yml.');
                const answer = await vscode.window.showWarningMessage(
                  `Run APM script "${definition.script}" in ${folder.name}? ${redact(scripts[definition.script!] as string)}\nScripts execute project-defined commands. APM must also have its scripts experimental feature enabled.`, 'Run');
                if (answer !== 'Run') { close.fire(0); return; }
              }
              const client = new ApmClient({ executable: settings.get<string>('executablePath', 'apm'), cwd: folder.uri.fsPath,
                environment,
                signal: controller.signal, onOutput: text => write.fire(redact(text).replace(/\r?\n/g, '\r\n')) });
              const flags = args.filter(value => value.startsWith('--'));
              if (!await client.supports([args[0]], flags)) throw new Error('The installed APM does not support this task. Upgrade APM.');
              if (controller.signal.aborted) { close.fire(130); return; }
              if (!vscode.workspace.isTrusted) throw new Error('Workspace Trust changed before task execution.');
              if (definition.workflow === 'script' && scriptManifest !== await readProjectManifest(folder.uri.fsPath)) throw new Error('The manifest changed after script confirmation. Review and run the script again.');
              const run = () => {
                if (!vscode.workspace.isTrusted) throw new Error('Workspace Trust changed before task execution.');
                return client.execute(args, { timeoutMs: null, captureOutput: false });
              };
              const exitCode = definition.workflow === 'script'
                ? await runScript(settings.get<string>('executablePath', 'apm'), args, folder, controller.signal)
                : (await (definition.workflow === 'compile' ? serialize(run) : run())).exitCode;
              if (exitCode !== 0 && !controller.signal.aborted) report(`APM ${definition.workflow} task exited with code ${exitCode}. Review its terminal.`);
              close.fire(exitCode === 0 ? 0 : 1);
            } catch (error) {
              const message = redact(error instanceof Error ? error.message : String(error));
              write.fire(`${message}\r\n`);
              if (!controller.signal.aborted) report(message);
              close.fire(controller.signal.aborted ? 130 : 1);
            } finally { active.delete(controller); write.dispose(); close.dispose(); }
          })();
        },
        close: () => { controller.abort(); active.delete(controller); write.dispose(); close.dispose(); }
      };
    });
    const task = new vscode.Task(definition, folder, definition.workflow === 'script' ? `script: ${definition.script}` : definition.workflow, 'APM', execution, []);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
    return task;
  };
  let discovery: Promise<vscode.Task[]> | undefined;
  const invalidate = () => { discovery = undefined; };
  const watcher = vscode.workspace.createFileSystemWatcher('**/apm.yml');
  const subscriptions = [
    watcher, watcher.onDidCreate(invalidate), watcher.onDidChange(invalidate), watcher.onDidDelete(invalidate),
    vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('apm.tasks.includeScripts')) invalidate();
    })
  ];
  const discover = async () => {
    if (!vscode.workspace.isTrusted) return [];
    const tasks: vscode.Task[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') continue;
      const text = await readProjectManifest(folder.uri.fsPath);
      if (text === undefined) continue;
      for (const workflow of Object.keys(commands) as (keyof typeof commands)[]) tasks.push(create({ type: 'apm', workflow }, folder));
      if (vscode.workspace.getConfiguration('apm', folder.uri).get<boolean>('tasks.includeScripts', false)) {
        const document = parseDocument(text);
        if (document.errors.length) throw new Error(`Cannot discover APM scripts: ${document.errors[0].message}`);
        const manifest: unknown = document.toJS();
        const scripts = record(manifest) ? manifest.scripts : undefined;
        if (record(scripts)) for (const [script, value] of Object.entries(scripts)) {
          if (typeof value === 'string') tasks.push(create({ type: 'apm', workflow: 'script', script }, folder));
        }
      }
    }
    return vscode.workspace.isTrusted ? tasks : [];
  };
  const provider = vscode.tasks.registerTaskProvider('apm', {
    provideTasks: () => {
      if (!vscode.workspace.isTrusted) return [];
      if (!discovery) {
        const pending = discover().catch(error => {
          if (discovery === pending) invalidate();
          throw error;
        });
        discovery = pending;
      }
      return discovery;
    },
    resolveTask: task => {
      if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before resolving APM tasks.');
      if (!task.scope || typeof task.scope === 'number' || task.scope.uri.scheme !== 'file') throw new Error('APM tasks require an explicit filesystem workspace folder.');
      const definition = task.definition;
      if (definition.type !== 'apm' || typeof definition.workflow !== 'string' || Object.keys(definition).some(key => !['type', 'workflow', 'script'].includes(key))) throw new Error('Invalid APM task definition.');
      return create(definition as ApmTaskDefinition, task.scope);
    }
  });
  return { dispose() { provider.dispose(); for (const subscription of subscriptions) subscription.dispose(); for (const controller of active) controller.abort(); active.clear(); } };
}
