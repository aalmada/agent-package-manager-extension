import * as vscode from 'vscode';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { readContained, resolveContained } from './apm/manifest';
import type { AuditReport } from './apm/actions';
import type { ContentGroup } from './apm/contents';
import type { Scope } from './apm/types';

export interface NavigationTarget { root: string; path: string; line?: number; column?: number; uri?: vscode.Uri }
export interface AuditTicket { key: string; generation: number; run: number }

export async function contentNavigation(root: string, groups: ContentGroup[], installed: boolean, deployed = false): Promise<Map<string, NavigationTarget>> {
  const targets = new Map<string, NavigationTarget>();
  for (const group of groups) for (const item of group.items) {
    delete item.navigationId; delete item.locationKind;
    if (!item.path) continue;
    let path = item.path;
    const actual = await resolveContained(root, path);
    if (!actual) continue;
    if ((await stat(actual)).isDirectory()) {
      const marker = group.kind === 'extensions' ? 'extension.mjs' : group.kind === 'skills' ? 'SKILL.md' : undefined;
      if (!marker || !await resolveContained(root, join(path, marker))) continue;
      path = join(path, marker);
    }
    const id = `content:${targets.size}`;
    targets.set(id, { root, path });
    item.navigationId = id;
    item.locationKind = installed ? deployed ? 'deployed' : 'installed' : 'source';
  }
  return targets;
}

export async function openNavigation(target: NavigationTarget): Promise<void> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before opening APM package content.');
  const actual = await resolveContained(target.root, target.path);
  if (!actual) throw new Error('This APM file is no longer available. Refresh and retry.');
  const uri = target.uri ?? vscode.Uri.file(actual);
  const document = await vscode.workspace.openTextDocument(uri);
  const line = Math.max(0, Math.min(document.lineCount - 1, (target.line ?? 1) - 1));
  const column = Math.max(0, Math.min(document.lineAt(line).text.length, (target.column ?? 1) - 1));
  const position = new vscode.Position(line, column);
  await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preview: true });
}

export class AuditDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('apm');
  private readonly decoded = new Map<string, string>();
  private readonly scopes = new Map<string, vscode.Uri[]>();
  private readonly runs = new Map<string, number>();
  private readonly sourceScopes = new Map<string, string>();
  private readonly sourceFiles = new Map<string, Set<string>>();
  private readonly watchers = new Map<string, vscode.FileSystemWatcher[]>();
  private generation = 0;
  private readonly provider = vscode.workspace.registerTextDocumentContentProvider('apm-decoded', {
    provideTextDocumentContent: uri => {
      const content = this.decoded.get(uri.toString());
      if (content === undefined) throw new Error('This decoded audit result has expired. Run the audit again.');
      return content;
    }
  });
  private readonly actions = vscode.languages.registerCodeActionsProvider([{ scheme: 'file' }, { scheme: 'apm-decoded' }], {
    provideCodeActions: (_document, _range, context) => context.diagnostics.filter(d => d.source === 'APM').flatMap(diagnostic => {
      const show = new vscode.CodeAction('APM: Show audit output', vscode.CodeActionKind.QuickFix);
      show.diagnostics = [diagnostic]; show.command = { command: 'apm.output', title: show.title };
      const rerun = new vscode.CodeAction('APM: Re-run audit in this folder', vscode.CodeActionKind.QuickFix);
      rerun.diagnostics = [diagnostic]; rerun.command = { command: 'apm.auditWorkspace', title: rerun.title,
        arguments: [this.sourceScopes.has(_document.uri.toString()) ? vscode.Uri.file(this.sourceScopes.get(_document.uri.toString())!) : _document.uri] };
      return [show, rerun];
    })
  });
  private readonly changes = vscode.workspace.onDidChangeTextDocument(event => {
    if (event.document.uri.scheme !== 'file') return;
    this.generation++;
    if (this.collection.has(event.document.uri) || [...this.sourceFiles.values()].some(files => files.has(event.document.uri.toString()))) this.clear();
  });
  private readonly deletions = vscode.workspace.onDidDeleteFiles(() => this.clear());
  private readonly folders = vscode.workspace.onDidChangeWorkspaceFolders(() => this.clear());

  clear(): void {
    this.generation++; this.collection.clear(); this.decoded.clear(); this.scopes.clear(); this.runs.clear(); this.sourceScopes.clear(); this.sourceFiles.clear();
    for (const watchers of this.watchers.values()) for (const watcher of watchers) watcher.dispose();
    this.watchers.clear();
  }
  dispose(): void { this.clear(); this.collection.dispose(); this.provider.dispose(); this.actions.dispose(); this.changes.dispose(); this.deletions.dispose(); this.folders.dispose(); }

  begin(key: string): AuditTicket {
    const run = (this.runs.get(key) ?? 0) + 1;
    this.runs.set(key, run);
    return { key, generation: this.generation, run };
  }
  async publish(scope: Scope, report: AuditReport, key = scope.path, ticket = this.begin(key)): Promise<Map<string, NavigationTarget>> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before reading audit sources.');
    const { generation, run } = ticket;
    const navigation = new Map<string, NavigationTarget>();
    const entries = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
    const decoded = new Map<string, string>();
    const sources = new Set<string>();
    const sourceUris = new Set<string>();
    for (const finding of report.findings) {
      const actual = await resolveContained(scope.path, finding.file);
      if (!actual) continue;
      const text = await readContained(scope.path, finding.file);
      if (text === undefined) continue;
      sources.add(actual);
      sourceUris.add(vscode.Uri.file(actual).toString()); sourceUris.add(vscode.Uri.file(join(scope.path, finding.file)).toString());
      let uri = vscode.Uri.file(actual), content = text, line = finding.line, column = finding.column;
      if (finding.pointer) {
        const parts = finding.pointer.replace(/^#/, '').split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
        const value: unknown = parseDocument(text).getIn(parts);
        const scalar = value && typeof value === 'object' && 'value' in value ? value.value : value;
        if (typeof scalar !== 'string') continue;
        content = scalar;
        uri = vscode.Uri.from({ scheme: 'apm-decoded', path: `/${encodeURIComponent(key)}/${navigation.size}.txt`, query: `${generation}:${run}` });
        decoded.set(uri.toString(), content);
        line = finding.decodedLine; column = finding.decodedColumn;
      }
      const lines = content.split(/\r?\n/);
      const row = Math.max(0, Math.min(lines.length - 1, (line ?? 1) - 1));
      const col = Math.max(0, Math.min(lines[row].length, (column ?? 1) - 1));
      const severity = /critical|high|error/i.test(finding.severity) ? vscode.DiagnosticSeverity.Error :
        /medium|warning/i.test(finding.severity) ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
      const diagnostic = new vscode.Diagnostic(new vscode.Range(row, col, row, Math.min(lines[row].length, col + 1)),
        `${finding.message}${finding.remediation ? `\nRemediation: ${finding.remediation}` : ''}${!line ? '\nAPM did not supply a source line; attached to the document.' : ''}`, severity);
      diagnostic.source = 'APM'; diagnostic.code = finding.category;
      const entry = entries.get(uri.toString()) ?? { uri, diagnostics: [] };
      entry.diagnostics.push(diagnostic); entries.set(uri.toString(), entry);
      const id = `audit:${navigation.size}`;
      finding.navigationId = id;
      navigation.set(id, { root: scope.path, path: finding.file, uri, line: row + 1, column: col + 1 });
    }
    for (const primitive of report.coverage?.primitives.filter(value => value.status === 'incomplete') ?? []) {
      const actual = await resolveContained(scope.path, primitive.file);
      if (!actual) continue;
      sources.add(actual);
      sourceUris.add(vscode.Uri.file(actual).toString()); sourceUris.add(vscode.Uri.file(join(scope.path, primitive.file)).toString());
      const uri = vscode.Uri.file(actual), entry = entries.get(uri.toString()) ?? { uri, diagnostics: [] };
      const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0),
        `Incomplete APM scan coverage: ${primitive.diagnostic ?? primitive.status}. This is not a clean audit.`, vscode.DiagnosticSeverity.Warning);
      diagnostic.source = 'APM'; entry.diagnostics.push(diagnostic); entries.set(uri.toString(), entry);
    }
    if (ticket.key !== key || generation !== this.generation || this.runs.get(key) !== run || !vscode.workspace.isTrusted) {
      report.stale = true; report.passed = false;
      for (const finding of report.findings) delete finding.navigationId;
      return new Map();
    }
    for (const uri of this.scopes.get(key) ?? []) { this.collection.delete(uri); this.decoded.delete(uri.toString()); this.sourceScopes.delete(uri.toString()); }
    for (const watcher of this.watchers.get(key) ?? []) watcher.dispose();
    this.sourceFiles.set(key, sourceUris);
    this.watchers.set(key, [...sources].map(path => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dirname(path)), basename(path)));
      watcher.onDidChange(() => this.clear()); watcher.onDidDelete(() => this.clear()); watcher.onDidCreate(() => this.clear());
      return watcher;
    }));
    this.scopes.set(key, [...entries.values()].map(entry => entry.uri));
    for (const [uri, text] of decoded) this.decoded.set(uri, text);
    for (const entry of entries.values()) { this.collection.set(entry.uri, entry.diagnostics); this.sourceScopes.set(entry.uri.toString(), scope.path); }
    return navigation;
  }
}
