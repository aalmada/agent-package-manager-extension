import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApmClient } from '../apm/client';
import type { ExecutionResult } from '../apm/types';
import { record } from '../apm/adapters';
import { cliSettings, direction, normalize, pushArguments, same, settingValue, type CliValue } from './cliConfig';
import { addArguments, defaultName, legacyEntry, location, matches, planSync, resolvedText } from './marketplaces';

const LINKS = 'apm.sync.marketplaces';
const CONFIG = 'apm.sync.config';
const MIGRATED = 'apm.sync.legacyMarketplacesMigrated';

function summary(result: ExecutionResult) {
  return (result.stderr || result.stdout).replace(/\[[x*i+!]\]\s*/g, '').replace(/\s+/g, ' ').trim() || `exit code ${result.exitCode}`;
}

/** Keeps `apm.marketplaces` and `apm.config.*` mirrored with the user's APM registry and config.json. */
export class SettingsSync {
  private running?: Promise<void>;
  private again = false;
  private readonly failed = new Map<string, string>();
  constructor(
    private readonly state: vscode.Memento,
    private readonly client: () => ApmClient,
    private readonly log: (text: string) => void,
    private readonly reportError: (message: string) => void,
    private readonly serialize: (operation: () => Promise<void>) => Promise<void>
  ) {}

  /** Forget failed marketplace entries so they are retried; omit `keep` to retry all. */
  retry(keep?: readonly string[]) {
    for (const text of [...this.failed.keys()]) if (!keep?.includes(text)) this.failed.delete(text);
  }

  sync(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.again) { this.again = false; void this.sync(); }
    });
    return this.running;
  }

  private async run() {
    if (!vscode.workspace.isTrusted) return;
    await this.serialize(async () => {
      if (!vscode.workspace.isTrusted) return;
      for (const part of [() => this.config(), () => this.marketplaces()]) {
        try { await part(); } catch (error) { this.reportError(error instanceof Error ? error.message : String(error)); }
      }
    });
  }

  private async readConfig(client: ApmClient): Promise<Record<string, unknown>> {
    try {
      const data: unknown = JSON.parse(await readFile(join(client.home, '.apm', 'config.json'), 'utf8'));
      if (!record(data)) throw new Error('APM config.json must contain an object.');
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async config() {
    const client = this.client(), settings = vscode.workspace.getConfiguration('apm');
    let file = await this.readConfig(client);
    const last = this.state.get<Record<string, unknown>>(CONFIG, {}), next: Record<string, unknown> = { ...last };
    for (const definition of cliSettings) {
      const desired = normalize(definition, settings.get(definition.setting));
      let actual = normalize(definition, file[definition.file]);
      const way = direction(desired, actual, last[definition.key], settings.inspect(definition.setting)?.globalValue !== undefined);
      if (way === 'push') {
        const current = normalize(definition, vscode.workspace.getConfiguration('apm').get(definition.setting));
        if (!same(current, desired)) { this.again = true; continue; }
        this.log(`Settings: apm ${pushArguments(definition, desired).join(' ')}\n`);
        const result = await client.execute(pushArguments(definition, desired));
        file = await this.readConfig(client);
        actual = normalize(definition, file[definition.file]);
        if (result.exitCode === 0 && same(actual, desired)) { next[definition.key] = desired; continue; }
        this.reportError(`APM could not apply setting ${definition.key}: ${result.exitCode === 0 ? 'the persisted value differs from the requested value' : summary(result)}.`);
      }
      if (way !== 'none') {
        const current = normalize(definition, vscode.workspace.getConfiguration('apm').get(definition.setting));
        if (same(current, desired)) await this.write(`apm.${definition.setting}`, settingValue(definition, actual));
        else this.again = true;
      }
      next[definition.key] = actual;
    }
    await this.state.update(CONFIG, next);
  }

  private marketplaceSetting(): string[] {
    const value = vscode.workspace.getConfiguration('apm').get<unknown>('marketplaces', []);
    if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) throw new Error('APM Marketplaces must be a list of strings.');
    return value;
  }

  private async migrateLegacy(workspaceRoot?: string) {
    if (this.state.get<boolean>(MIGRATED)) return;
    const legacy = vscode.workspace.getConfiguration('apm').inspect<unknown>('marketplaceEntries')?.globalValue;
    if (legacy !== undefined) {
      if (!Array.isArray(legacy)) throw new Error('The previous apm.marketplaceEntries setting must be an array before it can be migrated.');
      const entries = legacy.map((value, index) => {
        try { return legacyEntry(value, workspaceRoot); }
        catch (error) { throw new Error(`Cannot migrate marketplace entry ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
      });
      const current = this.marketplaceSetting();
      const merged = [...new Set([...current, ...entries])];
      if (!same(current, merged)) await this.write('apm.marketplaces', merged);
      await vscode.workspace.getConfiguration('apm').update('marketplaceEntries', undefined, vscode.ConfigurationTarget.Global);
    }
    await this.state.update(MIGRATED, true);
  }

  private async marketplaces() {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
    const workspaceRoot = folders.length === 1 ? folders[0].uri.fsPath : undefined;
    await this.migrateLegacy(workspaceRoot);
    const client = this.client(), setting = this.marketplaceSetting();
    let registered = await client.getMarketplaces();
    const previous = this.state.get<Record<string, string>>(LINKS, {});
    const plan = planSync(setting, registered, previous, new Set(this.failed.keys()), workspaceRoot);
    const pending = new Set(plan.remove);
    const links = { ...plan.links };
    const partial = { ...previous };
    for (const [text, name] of Object.entries(previous)) if (pending.has(name)) links[text] = name;
    const unchanged = () => same(this.marketplaceSetting(), setting);
    const savePartialIfChanged = async () => {
      if (unchanged()) return false;
      this.again = true;
      await this.state.update(LINKS, partial);
      return true;
    };
    const preserve = (name: string) => {
      for (const [text, previousName] of Object.entries(previous)) {
        if (previousName !== name) continue;
        if (!plan.setting.includes(text)) plan.setting.push(text);
        links[text] = name;
      }
    };
    const forgetName = (map: Record<string, string>, name: string) => {
      for (const [text, existing] of Object.entries(map)) if (existing.toLowerCase() === name.toLowerCase()) delete map[text];
    };
    for (const { text, error } of plan.invalid) {
      if (this.failed.get(text) !== error) { this.failed.set(text, error); this.reportError(`Marketplace setting: ${error}`); }
    }
    let additionsSucceeded = plan.invalid.length === 0 && !setting.some(text => this.failed.has(text.trim()));
    for (const entry of plan.add) {
      if (await savePartialIfChanged()) return;
      const candidate = defaultName(entry);
      const sameSource = entry.name ? [] : registered.filter(m => pending.has(m.name) && location(m.source) === location(entry.source));
      const named = registered.find(m => m.name.toLowerCase() === candidate.toLowerCase());
      const replacement = sameSource.length === 1 ? sameSource[0] : named && pending.has(named.name) ? named : undefined;
      const name = replacement?.name ?? candidate;
      const clash = registered.find(m => m.name.toLowerCase() === name.toLowerCase());
      if (sameSource.length > 1 || (clash && clash !== replacement)) {
        const message = `Marketplace "${entry.text}" conflicts with an existing registration. Prefix it with a unique name, for example "${candidate}-2=${entry.source}".`;
        this.failed.set(entry.text, message); this.reportError(message); additionsSucceeded = false; continue;
      }
      const namedEntry = { ...entry, name };
      this.log(`Settings: apm ${addArguments(namedEntry).join(' ')}\n`);
      const result = await client.execute(addArguments(namedEntry), { timeoutMs: 5 * 60_000 });
      registered = await client.getMarketplaces();
      const created = registered.find(m => matches(namedEntry, m));
      if (result.exitCode !== 0 || !created) {
        const message = `Could not add marketplace "${entry.text}": ${summary(result)}`;
        this.failed.set(entry.text, message); this.reportError(message); additionsSucceeded = false; continue;
      }
      if (replacement) pending.delete(replacement.name);
      forgetName(links, created.name); forgetName(partial, created.name);
      links[resolvedText(entry)] = created.name;
      partial[entry.text] = created.name;
      this.failed.delete(entry.text);
    }
    if (await savePartialIfChanged()) return;
    if (!additionsSucceeded) {
      for (const name of pending) preserve(name);
    } else if (pending.size) {
      const yes = await client.supports(['marketplace', 'remove'], ['--yes']);
      if (!yes) {
        this.reportError('This APM CLI cannot remove marketplaces non-interactively. Upgrade it or use APM Tools.');
        for (const name of pending) preserve(name);
      } else for (const name of pending) {
        if (await savePartialIfChanged()) return;
        this.log(`Settings: apm marketplace remove ${name}\n`);
        const result = await client.execute(['marketplace', 'remove', name, '--yes']);
        registered = await client.getMarketplaces();
        if (result.exitCode !== 0 || registered.some(m => m.name.toLowerCase() === name.toLowerCase())) {
          this.reportError(`Could not remove marketplace ${name}: ${summary(result)}`);
          preserve(name);
        } else { forgetName(links, name); forgetName(partial, name); }
      }
    }
    if (await savePartialIfChanged()) return;
    if (!same(plan.setting, setting)) await this.write('apm.marketplaces', plan.setting.length ? plan.setting : undefined);
    await this.state.update(LINKS, links);
  }

  private async write(key: string, value: CliValue | string[] | undefined) {
    const [section, ...rest] = key.split('.');
    await vscode.workspace.getConfiguration(section).update(rest.join('.'), value, vscode.ConfigurationTarget.Global);
  }
}
