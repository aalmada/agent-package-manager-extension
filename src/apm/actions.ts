import type { Marketplace, PackageItem } from './types';
import { record } from './adapters';

export const packageActions = ['install', 'installWithOptions', 'uninstall', 'update', 'audit', 'previewInstall', 'previewUpdate', 'previewWithOptions', 'applyPreview'] as const;
export type PackageAction = typeof packageActions[number];

export interface VersionRef { name: string; type: string; commit: string }
export interface AuditFinding {
  severity: string;
  file: string;
  message: string;
  category?: string;
  remediation?: string;
  line?: number;
  column?: number;
  decodedLine?: number;
  decodedColumn?: number;
  pointer?: string;
  navigationId?: string;
}
export interface AuditCoverageEntry {
  file: string;
  status: string;
  target?: string;
  kind?: string;
  pointer?: string;
  diagnostic?: string;
  tracked?: boolean;
  strippable?: boolean;
}
export interface AuditReport {
  passed: boolean;
  stale?: boolean;
  exitCode?: number;
  summary: Record<string, number>;
  findings: AuditFinding[];
  coverage?: { complete: boolean; primitives: AuditCoverageEntry[] };
}
export interface ActionResult {
  action: PackageAction;
  title: string;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  command: string;
  summary?: string;
  output?: string;
  audit?: AuditReport;
  preview?: boolean;
}

/** The argument APM accepts for this package: marketplace notation for installs, the lockfile identity otherwise. */
export function packageIdentity(item: PackageItem, installed: PackageItem | undefined, forInstall: boolean): string {
  if (forInstall && typeof item.metadata?.installExpression === 'string') return item.metadata.installExpression;
  const source = installed ?? item;
  if (typeof source.metadata?.cliIdentity === 'string') return source.metadata.cliIdentity;
  if (typeof source.metadata?.lockIdentity === 'string') return source.metadata.lockIdentity;
  return item.marketplace ? `${item.name}@${item.marketplace}` : String(item.source ?? item.name);
}

export function packageUpdateCommand(item: PackageItem): { id: 'install' | 'update'; packages: string } {
  const identity = packageIdentity(item, item, false);
  const update = record(item.metadata?.update) ? item.metadata.update : undefined;
  if (update?.source !== 'git tags') return { id: 'update', packages: identity };
  if (item.direct === false) throw new Error('Update the parent dependency to change a transitive package version.');
  const latest = item.latestVersion;
  if (!latest || latest === '-' || /…|\.\.\./.test(latest)) throw new Error('APM did not report a usable latest tag. Choose a version explicitly.');
  return { id: 'install', packages: withRef(identity, latest) };
}

export function verifyPackageUpdate(result: ActionResult, item: PackageItem | undefined, refreshError?: string): ActionResult {
  if (result.action !== 'update' || result.status !== 'success') return result;
  if (!refreshError && item?.installed && item.updateStatus === 'current' && !item.updateStale) {
    return { ...result, summary: 'Update verified. This package is up to date.' };
  }
  const summary = refreshError ? `APM completed, but the update could not be verified: ${refreshError}` :
    item?.updateStatus === 'outdated' && !item.updateStale
      ? `APM completed, but this package still has an update available${item.latestVersion ? `: ${item.latestVersion}` : ''}.`
      : 'APM completed, but the update could not be verified. Refresh and review APM Output.';
  return { ...result, status: 'failed', summary };
}

/** Repository whose tags and branches represent a package's versions. */
export function versionSource(item: PackageItem, installed: PackageItem | undefined, marketplaces: Marketplace[]): string {
  if (installed) return packageIdentity(item, installed, false);
  const plugin = record(item.metadata?.plugin) ? item.metadata.plugin : undefined;
  const source = plugin?.source;
  if (record(source) && typeof source.repo === 'string' && source.repo) return source.repo;
  if (record(source) && typeof source.url === 'string' && /^https:\/\//.test(source.url)) return source.url;
  const marketplace = marketplaces.find(m => m.name === item.marketplace);
  if (marketplace?.source && (typeof source === 'string' || !source)) return marketplace.source;
  return packageIdentity(item, installed, true);
}

/** Appends a git ref to an install expression (`name@marketplace#ref` or `owner/repo#ref`). */
export function withRef(expression: string, ref: string): string {
  const value = ref.trim();
  if (!value) return expression;
  if (/[\s#]/.test(value) || value.startsWith('-')) throw new Error('A ref cannot contain spaces or "#", or begin with "-".');
  return `${expression.replace(/#.*$/, '')}#${value}`;
}

const cell = /^[│|┃](.+)[│|┃]\s*$/;
export function parseVersions(text: string): VersionRef[] {
  const rows: VersionRef[] = [];
  let header = false;
  for (const line of text.split(/\r?\n/)) {
    const match = cell.exec(line.trim());
    if (!match) continue;
    const [name, type = '', commit = ''] = match[1].split(/[│|┃]/).map(part => part.trim());
    if (/^name$/i.test(name) && /^type$/i.test(type)) { header = true; continue; }
    if (header && name) rows.push({ name, type, commit });
  }
  return rows;
}

export function parseAudit(text: string): AuditReport | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let value: unknown;
  try { value = JSON.parse(text.slice(start)); } catch { return undefined; }
  if (!record(value)) return undefined;
  const summary: Record<string, number> = {};
  if (record(value.summary)) for (const [key, count] of Object.entries(value.summary)) if (typeof count === 'number') summary[key] = count;
  const findings = (Array.isArray(value.findings) ? value.findings : []).filter(record).map(finding => ({
    severity: String(finding.severity ?? finding.level ?? 'info'),
    file: String(finding.file ?? finding.path ?? finding.location ?? ''),
    message: String(finding.message ?? finding.description ?? finding.rule ?? finding.type ?? 'Finding'),
    ...(typeof finding.category === 'string' ? { category: finding.category } : {}),
    ...(typeof finding.remediation === 'string' ? { remediation: finding.remediation } : {}),
    ...(typeof finding.line === 'number' ? { line: finding.line } : {}),
    ...(typeof finding.column === 'number' ? { column: finding.column } : {}),
    ...(typeof finding.decoded_line === 'number' ? { decodedLine: finding.decoded_line } : {}),
    ...(typeof finding.decoded_column === 'number' ? { decodedColumn: finding.decoded_column } : {}),
    ...(typeof finding.pointer === 'string' ? { pointer: finding.pointer } : {})
  }));
  let coverage: AuditReport['coverage'];
  if (value.coverage !== undefined) {
    if (!record(value.coverage) || typeof value.coverage.complete !== 'boolean' || !Array.isArray(value.coverage.primitives)) {
      throw new Error('Unrecognized APM audit coverage report. Review APM Output.');
    }
    const primitives = value.coverage.primitives.map((entry: unknown): AuditCoverageEntry => {
      if (!record(entry) || typeof entry.file !== 'string' || typeof entry.status !== 'string') {
        throw new Error('Unrecognized APM audit coverage entry. Review APM Output.');
      }
      return {
        file: entry.file, status: entry.status,
        ...(typeof entry.target === 'string' ? { target: entry.target } : {}),
        ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
        ...(typeof entry.pointer === 'string' ? { pointer: entry.pointer } : {}),
        ...(typeof entry.diagnostic === 'string' ? { diagnostic: entry.diagnostic } : {}),
        ...(typeof entry.tracked === 'boolean' ? { tracked: entry.tracked } : {}),
        ...(typeof entry.strippable === 'boolean' ? { strippable: entry.strippable } : {})
      };
    });
    coverage = { complete: value.coverage.complete && !primitives.some(entry => entry.status === 'incomplete'), primitives };
  }
  const exitCode = typeof value.exit_code === 'number' ? value.exit_code : undefined;
  return {
    passed: value.passed === true && coverage?.complete !== false && (exitCode === undefined || exitCode === 0),
    summary, findings, ...(exitCode !== undefined ? { exitCode } : {}), ...(coverage ? { coverage } : {})
  };
}

/** Parses the `--target` values listed by `apm install --help`. */
export function parseTargets(help: string): string[] {
  const block = /^\s{0,4}(?:-\w, )?--target\b([\s\S]*?)(?=\n\s{0,4}-|$(?![\s\S]))/m.exec(help)?.[1] ?? '';
  const values = /Values:\s*([\s\S]*?)\./.exec(block.replace(/\s+/g, ' '))?.[1];
  return values ? values.split(',').map(v => v.trim()).filter(v => /^[a-z0-9-]+$/.test(v)) : [];
}

export function tail(text: string, limit = 60_000): string {
  return text.length > limit ? `…(truncated; see the APM output channel for the full log)\n${text.slice(-limit)}` : text;
}
