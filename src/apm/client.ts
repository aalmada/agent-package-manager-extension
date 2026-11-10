import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseCatalog, parseInstalled, parseOutdated, parseVariablePrompt, record, stripAnsi, type VariablePrompt } from './adapters';
import { baseline, descriptors } from './commands';
import { declaredContents, mergeContents } from './contents';
import { marketplaceManifest, readMarketplaces, resolveContained } from './manifest';
import { remoteSource, inspectBarePackage, inspectRemotePackage, inspectLocalPackage, type PackageMetadata } from './packageMetadata';
import { containsUrlCredentials } from './redact';
import type { RepositoryHost } from '../auth/repositories';
import type { ExecutionResult, Marketplace, PackageItem, Probe, Scope, UpdateRow } from './types';

export class ApmError extends Error {
  constructor(message: string, public readonly result?: ExecutionResult) { super(message); this.name = 'ApmError'; }
}

export class ApmClient {
  readonly home: string;
  constructor(private readonly config: { executable: string; cwd: string; home?: string; signal?: AbortSignal; onOutput?: (text: string) => void;
    environment?: (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<Record<string, string>>; fetcher?: typeof fetch;
    repositoryHosts?: () => readonly RepositoryHost[] }) {
    this.home = config.home ?? homedir();
  }
  async execute(args: string[], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number | null; captureOutput?: boolean; inputLines?: readonly string[]; onPrompt?: (prompt: VariablePrompt) => Promise<string | undefined> } = {}): Promise<ExecutionResult> {
    if (args.some(containsUrlCredentials)) throw new ApmError('Do not put credentials in URLs. Remove them and use APM authentication.');
    if (options.inputLines?.some(line => /[\r\n\0]/.test(line))) throw new ApmError('APM input values cannot contain line breaks or NUL.');
    if (options.inputLines && options.onPrompt) throw new ApmError('APM input cannot combine prepared answers with interactive prompts.');
    const signal = options.signal ?? this.config.signal;
    if (signal?.aborted) throw new ApmError('APM operation cancelled.');
    const environment = await this.config.environment?.(args, options.cwd ?? this.config.cwd, signal) ?? {};
    if (signal?.aborted) throw new ApmError('APM operation cancelled.');
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.executable, args, {
        cwd: options.cwd ?? this.config.cwd, shell: false,
        env: {
          ...process.env, ...environment, HOME: this.home, USERPROFILE: this.home,
          ...(this.config.home ? {
            APM_CACHE_DIR: join(this.home, '.cache', 'apm'), XDG_CACHE_HOME: join(this.home, '.cache'),
            XDG_CONFIG_HOME: join(this.home, '.config'), LOCALAPPDATA: join(this.home, 'AppData', 'Local'),
            GIT_CONFIG_GLOBAL: join(this.home, '.gitconfig')
          } : {}),
          NO_COLOR: '1', TERM: 'dumb', COLUMNS: '10000', PYTHONIOENCODING: 'utf-8'
        },
        stdio: [options.onPrompt || options.inputLines ? 'pipe' : 'ignore', 'pipe', 'pipe']
      });
      let prompting = false;
      const answers: string[] = Object.entries(environment)
        .filter(([name, value]) => /TOKEN|SECRET|PASSWORD|(?:^|_)PAT$/.test(name) && value)
        .map(([, value]) => value);
      const protect = (text: string) => [...answers].sort((a, b) => b.length - a.length)
        .reduce((output, value) => output.split(value).join('[redacted]'), stripAnsi(text));
      const answer = (prompt: VariablePrompt) => {
        prompting = true;
        options.onPrompt!(prompt).then(value => {
          if (value === undefined) child.stdin?.end();
          else {
            if (value) answers.push(value);
            child.stdin?.write(`${value}\n`);
          }
        }, () => child.stdin?.end()).finally(() => { prompting = false; });
      };
      child.stdin?.on('error', () => undefined);
      if (options.inputLines) child.stdin?.end(`${options.inputLines.join('\n')}\n`);
      let stdout = '', stderr = '', failure: string | undefined;
      const pending = { stdout: '', stderr: '' };
      const flushOutput = (stream: 'stdout' | 'stderr') => {
        if (pending[stream]) this.config.onOutput?.(protect(pending[stream]));
        pending[stream] = '';
      };
      const flushAll = () => { flushOutput('stdout'); flushOutput('stderr'); };
      const cancel = () => { failure = 'APM operation cancelled; partial changes may remain.'; stop(); };
      signal?.addEventListener('abort', cancel, { once: true });
      const timeout = options.timeoutMs === null ? undefined : setTimeout(() => { failure = 'APM operation timed out; partial changes may remain.'; stop(); }, options.timeoutMs ?? 120_000);
      let force: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        child.kill('SIGTERM');
        force = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
        force.unref();
      };
      const collect = (stream: 'stdout' | 'stderr', text: string) => {
        if (stdout.length + stderr.length + (options.captureOutput === false ? pending[stream].length : 0) + text.length > 16 * 1024 * 1024) {
          if (!failure) { failure = 'APM output exceeded the 16 MB safety limit.'; stop(); }
          return;
        }
        if (options.captureOutput !== false) {
          if (stream === 'stdout') stdout += text; else stderr += text;
        }
        pending[stream] += text;
        const end = pending[stream].lastIndexOf('\n');
        if (end >= 0) {
          this.config.onOutput?.(protect(pending[stream].slice(0, end + 1)));
          pending[stream] = pending[stream].slice(end + 1);
        }
        if (options.onPrompt && !prompting && stream === 'stdout') {
          const prompt = parseVariablePrompt(stdout, pending.stdout);
          if (prompt) { flushOutput('stdout'); answer(prompt); }
        }
      };
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', (text: string) => collect('stdout', text));
      child.stderr!.on('data', (text: string) => collect('stderr', text));
      const cleanup = () => { clearTimeout(timeout); if (force) clearTimeout(force); signal?.removeEventListener('abort', cancel); };
      child.once('error', error => { cleanup(); flushAll(); reject(new ApmError(`Could not start APM: ${error.message}`)); });
      child.once('close', (code, signal) => {
        cleanup();
        flushAll();
        const result = { stdout: protect(stdout), stderr: protect(stderr), exitCode: code ?? -1 };
        if (failure || signal) reject(new ApmError(failure ?? `APM terminated by ${signal}.`, result));
        else resolve(result);
      });
    });
  }
  private async checked(args: string[], cwd?: string): Promise<ExecutionResult> {
    const result = await this.execute(args, { cwd });
    if (result.exitCode !== 0) throw new ApmError(`apm ${args.join(' ')} failed (${result.exitCode}).\n${result.stderr || result.stdout}`, result);
    return result;
  }
  async probe(): Promise<Probe> {
    const result = await this.checked(['--version']);
    const version = result.stdout.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/)?.[1];
    if (!version) throw new ApmError('Unrecognized APM version output.', result);
    const help = await this.checked(['--help']);
    const section = help.stdout.split('Commands:')[1]?.split(/\n\s*\n/)[0] ?? '';
    const commands = [...section.matchAll(/^\s{2}([a-z][a-z-]+)\s/gm)].map(match => match[1]);
    if (!commands.length) throw new ApmError('Unrecognized APM command help.', help);
    return { version, commands, warning: olderThan(version, baseline) ? `APM ${version} is out of date. Update to APM ${baseline} or later to use every feature.` : undefined };
  }
  async supports(command: string[], flags: string[] = []): Promise<boolean> {
    const result = await this.execute([...command, '--help']);
    if (result.exitCode !== 0) return false;
    if (!flags.length) return true;
    const parseFlags = (text: string) => new Set(text.split('\n').filter(line => /^\s{2}(?:-\w,\s+)?--/.test(line)).flatMap(line => line.match(/--[\w-]+/g) ?? []));
    const available = parseFlags(result.stdout);
    if (flags.some(flag => !available.has(flag))) {
      for (let depth = 0; depth < command.length; depth++) {
        const parent = await this.execute([...command.slice(0, depth), '--help']);
        if (parent.exitCode === 0) for (const flag of parseFlags(parent.stdout)) available.add(flag);
      }
    }
    const hidden = descriptors.find(d => d.id === command.join(' '))?.options.filter(o => o.hidden) ?? [];
    for (const flag of flags.filter(flag => !available.has(flag))) {
      const option = hidden.find(o => o.name === flag);
      if (!option) return false;
      const value = option.choices?.[0] ?? (option.type === 'number' ? '1' : 'main');
      const probe = await this.execute([...command, option.type === 'boolean' ? flag : `${flag}=${value}`, '--help']);
      if (probe.exitCode !== 0) return false;
    }
    return true;
  }
  getMarketplaces(): Promise<Marketplace[]> { return readMarketplaces(this.home); }
  async getCatalog(marketplaces: Marketplace[]): Promise<{ items: PackageItem[]; errors: string[] }> {
    const items: PackageItem[] = [], errors: string[] = [];
    // Keep requests bounded; CLI fetching also owns transport authentication.
    for (const marketplace of marketplaces) {
      try {
        await this.checked(['marketplace', 'update', marketplace.name]);
        let manifest: Record<string, unknown> | undefined;
        try {
          const snapshot = await marketplaceManifest(marketplace, this.home);
          manifest = snapshot.manifest;
        } catch (error) {
          errors.push(`${marketplace.name}: Full manifest could not be read; using the CLI table. ${String(error)}`);
        }
        if (manifest && Array.isArray(manifest.plugins)) {
          const seen = new Set<string>();
          for (const plugin of manifest.plugins) {
            if (!record(plugin) || typeof plugin.name !== 'string' || !plugin.name) throw new ApmError(`Invalid plugin name in ${marketplace.name}. Run marketplace validate.`);
            if (seen.has(plugin.name.toLowerCase())) throw new ApmError(`Duplicate plugin name in ${marketplace.name}: ${plugin.name}. Run marketplace validate.`);
            seen.add(plugin.name.toLowerCase());
            items.push({
              id: `${marketplace.name}::${plugin.name}`, name: plugin.name, marketplace: marketplace.name,
              version: typeof plugin.version === 'string' && plugin.version ? plugin.version : 'Not specified',
              description: typeof plugin.description === 'string' ? plugin.description : undefined,
              installed: false, metadata: { plugin, installExpression: `${plugin.name}@${marketplace.name}` }
            });
          }
          continue;
        }
        const result = await this.checked(['marketplace', 'browse', marketplace.name]);
        items.push(...parseCatalog(result.stdout, marketplace.name));
      } catch (error) {
        errors.push(`${marketplace.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { items, errors };
  }
  async getInstalled(scope: Scope): Promise<PackageItem[]> {
    if (scope.kind === 'global') {
      try { await stat(scope.path); } catch (error) { if (isMissing(error)) return []; throw error; }
    }
    const args = ['deps', 'list', ...(scope.kind === 'global' ? ['--global'] : [])];
    const result = await this.checked(args, scope.kind === 'global' ? this.home : scope.path);
    const items = parseInstalled(result.stdout);
    let lock: unknown;
    try { lock = parseYaml(await readFile(join(scope.path, 'apm.lock.yaml'), 'utf8')); }
    catch (error) { if (!isMissing(error)) throw new ApmError(`Cannot read lockfile: ${String(error)}`); }
    const dependencies: Record<string, unknown>[] = record(lock) && Array.isArray(lock.dependencies) ? lock.dependencies.filter(record) : [];
    const deployments = record(lock) && Array.isArray(lock.deployments) ? lock.deployments.filter(record) : [];
    for (const dep of dependencies) {
      if (dep.package_type !== 'claude_skill' || !Array.isArray(dep.deployed_files) || items.some(item => matchesDependency(item.name, dep))) continue;
      const identity = dependencyIdentity(dep);
      if (!identity) continue;
      for (const path of dep.deployed_files) {
        if (typeof path !== 'string' || !/[\\/]SKILL\.md$/i.test(path)) continue;
        const deployment = deployments.find(entry => entry.kind === 'project-relative' && entry.value === path);
        if (deployment && deployment.active_owner !== identity) continue;
        const actual = await resolveContained(scope.path, path);
        if (!actual || !(await stat(actual)).isFile()) continue;
        const cliIdentity = typeof dep.alias === 'string' && dep.alias ? dep.alias : identity;
        items.push({
          id: `installed::${cliIdentity}`, name: cliIdentity, marketplace: '', installed: true,
          version: typeof dep.version === 'string' && dep.version !== 'unknown' ? dep.version : 'Not specified',
          updateStatus: 'unchecked',
          metadata: { cliIdentity, deployedSkillPath: path }
        });
        break;
      }
    }
    return items.map(item => {
      const matching = dependencies.filter(dep => matchesDependency(item.name, dep));
      if (matching.length !== 1) return item;
      const dep = matching[0];
      const marketplace = typeof dep.discovered_via === 'string' ? dep.discovered_via : '';
      const name = typeof dep.marketplace_plugin_name === 'string' && marketplace ? dep.marketplace_plugin_name :
        typeof item.metadata?.deployedSkillPath === 'string' ? basename(dirname(item.metadata.deployedSkillPath)) :
          typeof dep.name === 'string' ? dep.name : item.name;
      const local = dep.source === 'local' && typeof dep.local_path === 'string' ? dep.local_path : undefined;
      const lockIdentity = dependencyIdentity(dep) ?? item.name;
      const installExpression = marketplace ? `${name}@${marketplace}` : local ?? lockIdentity;
      return {
        ...item, id: marketplace ? `${marketplace}::${name}` : item.id, name, marketplace,
        direct: dep.depth === undefined || dep.depth === 1,
        source: local ?? (typeof dep.repo_url === 'string' ? dep.repo_url : item.source),
        metadata: { ...item.metadata, lock: dep, lockIdentity, installExpression }
      };
    });
  }
  async checkUpdates(scope: Scope, installed?: PackageItem[]): Promise<UpdateRow[]> {
    const result = await this.checked(['outdated', ...(scope.kind === 'global' ? ['--global'] : [])], scope.kind === 'global' ? this.home : scope.path);
    const items = installed ?? await this.getInstalled(scope);
    const allCurrent = /All dependencies are up-to-date/.test(result.stdout);
    const noRemote = /No remote dependencies to check/.test(result.stdout);
    const rows = allCurrent || noRemote ? [] : parseOutdated(result.stdout);
    for (const item of items) {
      const lock = record(item.metadata?.lock) ? item.metadata.lock : undefined;
      const identity = String(item.metadata?.lockIdentity ?? item.metadata?.cliIdentity ?? item.name);
      if (rows.some(row => row.package === identity || row.package === item.metadata?.cliIdentity)) continue;
      const excluded = lock?.source === 'local' || !!lock?.registry_prefix;
      if (excluded || (allCurrent && lock)) rows.push({
        package: identity, current: item.version, latest: allCurrent && !excluded ? item.version : '-',
        status: excluded ? 'not-comparable' : 'current', source: String(lock?.source ?? item.source ?? '')
      });
    }
    return rows;
  }
  async getDetails(item: PackageItem, scope: Scope): Promise<Record<string, unknown>> {
    const identity = item.installed ? String(item.metadata?.cliIdentity ?? item.name) : item.marketplace ? `${item.name}@${item.marketplace}` : item.name;
    const deployedSkillPath = item.installed && typeof item.metadata?.deployedSkillPath === 'string' ? item.metadata.deployedSkillPath : undefined;
    const result = deployedSkillPath || (!item.installed && item.marketplace) ? undefined :
      await this.checked(['view', identity, ...(scope.kind === 'global' ? ['--global'] : [])], scope.kind === 'global' ? this.home : scope.path);
    const metadata: Record<string, unknown> = { ...item.metadata, identity, ...(result ? { rawOutput: result.stdout } : {}) };
    let plugin = record(item.metadata?.plugin) ? item.metadata.plugin : undefined;
    let packageMetadata: PackageMetadata | undefined;
    if (item.marketplace) {
      const marketplace = (await this.getMarketplaces()).find(m => m.name === item.marketplace);
      if (marketplace) {
        try {
          const snapshot = await marketplaceManifest(marketplace, this.home);
          if (snapshot.manifest) {
            const plugins = snapshot.manifest.plugins;
            plugin = (Array.isArray(plugins) ? plugins.filter(record).find(p => p.name === item.name) : undefined) ?? plugin;
            metadata.marketplace = Object.fromEntries(Object.entries(snapshot.manifest).filter(([key]) => key !== 'plugins'));
          }
          if (plugin) metadata.plugin = plugin;
          if (snapshot.notice) metadata.metadataNotice = snapshot.notice;
          if (!item.installed && plugin) {
            if (snapshot.root && typeof plugin.source === 'string') {
              packageMetadata = await inspectLocalPackage(snapshot.root, plugin.source, { repositoryRoot: true });
            } else if (snapshot.gitDir && typeof plugin.source === 'string') {
              packageMetadata = await inspectBarePackage(snapshot.gitDir, snapshot.ref ?? 'main', plugin.source);
            } else {
              const source = remoteSource(plugin.source, marketplace, this.config.repositoryHosts?.());
              if (source) packageMetadata = await inspectRemotePackage(source, this.config.fetcher);
              else metadata.contentsNotice = 'The package source is not available locally; its contents may be incomplete.';
            }
          }
        } catch (error) { metadata.metadataError = `Full manifest unavailable: ${String(error)}`; }
      }
    }
    const lines = result?.stdout.split('\n') ?? [];
    for (const line of lines) {
      const match = line.match(/^\s*(?:[│|]\s*)?([A-Za-z][A-Za-z /_-]+):\s+(.+?)\s*(?:[│|]\s*)?$/);
      if (match) metadata[match[1].trim()] = match[2].trim();
    }
    const pathField = Object.keys(metadata).find(key => key.toLowerCase() === 'install path');
    const installPath = pathField && typeof metadata[pathField] === 'string' ? String(metadata[pathField]).replace(/[│|]\s*$/, '').trim() : undefined;
    if (deployedSkillPath) {
      if (!await resolveContained(scope.path, deployedSkillPath)) throw new ApmError('The deployed skill is no longer available.');
      packageMetadata = await inspectLocalPackage(scope.path, dirname(deployedSkillPath));
      packageMetadata.notes = [
        'This skill is installed in its deployment directory but is not listed by the CLI. Contents are read from the deployed skill, not the package cache.',
        ...(packageMetadata.notes ?? [])
      ];
    } else if (item.installed && installPath) {
      const allowedRoot = await realpath(join(scope.path, 'apm_modules'));
      const candidate = await realpath(isAbsolute(installPath) ? installPath : resolve(await realpath(scope.path), installPath));
      const rel = relative(allowedRoot, candidate);
      if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
        packageMetadata = await inspectLocalPackage(allowedRoot, rel);
      } else throw new ApmError('APM reported an installation path outside the selected package store.');
    }
    if (item.installed && !installPath && !deployedSkillPath) metadata.contentsNotice = 'APM did not report an installation path; package contents may be incomplete.';
    if (packageMetadata?.pluginManifest) metadata.packageManifest = packageMetadata.pluginManifest;
    if (packageMetadata?.manifest) metadata.manifest = packageMetadata.manifest;
    if (packageMetadata?.readme !== undefined) metadata.readme = packageMetadata.readme;
    if (packageMetadata?.notices.length) metadata.contentsNotices = packageMetadata.notices;
    if (packageMetadata?.notes?.length) metadata.contentsNotes = packageMetadata.notes;
    metadata.contents = mergeContents(declaredContents(plugin, packageMetadata?.pluginManifest, packageMetadata?.manifest), packageMetadata?.contents ?? []);
    if (packageMetadata?.localRoot) metadata.localContentRoot = packageMetadata.localRoot;
    return metadata;
  }
}

function dependencyIdentity(dep: Record<string, unknown>): string | undefined {
  if (dep.source === 'local' && typeof dep.local_path === 'string') {
    return typeof dep.anchored_local_path === 'string' ? `local:${dep.anchored_local_path}` : dep.local_path;
  }
  if (typeof dep.repo_url !== 'string' || !dep.repo_url) return undefined;
  const host = typeof dep.host === 'string' && dep.host !== 'github.com' && !dep.registry_prefix ? `${dep.host}/` : '';
  const virtual = dep.is_virtual && typeof dep.virtual_path === 'string' ? `/${dep.virtual_path}` : '';
  return `${host}${dep.repo_url}${virtual}`;
}

function matchesDependency(identity: string, dep: Record<string, unknown>): boolean {
  const repo = typeof dep.repo_url === 'string' ? dep.repo_url : '';
  const virtual = typeof dep.virtual_path === 'string' && dep.is_virtual ? `/${dep.virtual_path}` : '';
  const local = typeof dep.anchored_local_path === 'string' ? `local:${dep.anchored_local_path}` : dep.local_path;
  const host = typeof dep.host === 'string' ? dep.host.toLowerCase() : '';
  return [dep.alias, local, dep.local_path, repo + virtual, `${host}/${repo}${virtual}`, dependencyIdentity(dep)].includes(identity);
}

function isMissing(error: unknown): boolean {
  return record(error) && error.code === 'ENOENT';
}

export function olderThan(version: string, reference: string): boolean {
  const parts = (value: string) => value.split(/[-+]/)[0].split('.').map(Number);
  const [a, b] = [parts(version), parts(reference)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}
