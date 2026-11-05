import type { Marketplace, PackageItem } from './types';
import { record } from './adapters';

export const packageActions = ['install', 'installWithOptions', 'uninstall', 'update', 'audit', 'tree'] as const;
export type PackageAction = typeof packageActions[number];

export interface VersionRef { name: string; type: string; commit: string }
export interface AuditFinding { severity: string; file: string; message: string }
export interface AuditReport { passed: boolean; summary: Record<string, number>; findings: AuditFinding[] }
export interface ActionResult {
  action: PackageAction;
  title: string;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  command: string;
  summary?: string;
  output?: string;
  audit?: AuditReport;
}

/** The argument APM accepts for this package: marketplace notation for installs, the lockfile identity otherwise. */
export function packageIdentity(item: PackageItem, installed: PackageItem | undefined, forInstall: boolean): string {
  if (forInstall && typeof item.metadata?.installExpression === 'string') return item.metadata.installExpression;
  const source = installed ?? item;
  if (typeof source.metadata?.cliIdentity === 'string') return source.metadata.cliIdentity;
  if (typeof source.metadata?.lockIdentity === 'string') return source.metadata.lockIdentity;
  return item.marketplace ? `${item.name}@${item.marketplace}` : String(item.source ?? item.name);
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
    message: String(finding.message ?? finding.description ?? finding.rule ?? finding.type ?? 'Finding')
  }));
  return { passed: value.passed === true, summary, findings };
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
