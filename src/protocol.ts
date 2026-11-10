import type { CommandDescriptor, Marketplace, PackageItem, Scope } from './apm/types';
import { record } from './apm/adapters';
import { packageActions, type ActionResult, type PackageAction } from './apm/actions';
import { isWorkflow, type Workflow, type ResolvedTarget } from './apm/workflows';

export type Mode = 'browser' | 'details';
export const browserSections = ['catalog', 'installed', 'updates', 'direct', 'transitive', 'unclassified'] as const;
export type BrowserSection = typeof browserSections[number];
export type PackageSection = Extract<BrowserSection, 'catalog' | 'installed' | 'updates'>;
export interface State {
  mode: Mode;
  trusted: boolean;
  scopes: Scope[];
  scopeKey: string;
  browserSearch?: string;
  hiddenSections?: PackageSection[];
  version?: string;
  warning?: string;
  error?: string;
  errors: string[];
  busy: boolean;
  host?: string;
  projectPresent?: boolean;
  targets?: ResolvedTarget[];
  checkedAt?: string;
  catalog: PackageItem[];
  installed: PackageItem[];
  marketplaces: Marketplace[];
  commands: CommandDescriptor[];
  availableCommands: string[];
  result?: string;
  taskRunning?: boolean;
  item?: PackageItem;
  details?: Record<string, unknown>;
  readmeHtml?: string;
  readmeImagesBlocked?: { https: boolean; insecure: boolean };
  actionResult?: ActionResult;
}
export type Message =
  | { type: 'ready' | 'refresh' | 'install' | 'dependencies' | 'marketplaces' | 'setup' | 'output' | 'trust' | 'settings' | 'readmeImageSettings' | 'cancel' | 'chooseScope' | 'targets' | 'configureTargets' | 'retry' }
  | { type: 'scope'; key: string }
  | { type: 'filters'; search: string }
  | { type: 'details'; id: string; scopeKey?: string }
  | { type: 'packageAction'; action: PackageAction }
  | { type: 'external'; url: string }
  | { type: 'workflow'; workflow: Workflow }
  | { type: 'navigate'; id: string }
  | { type: 'openTarget'; target: string };

export function parseMessage(value: unknown): Message {
  if (!record(value) || typeof value.type !== 'string') throw new Error('Invalid webview message.');
  const simple = ['ready', 'refresh', 'install', 'dependencies', 'marketplaces', 'setup', 'output', 'trust', 'settings', 'readmeImageSettings', 'cancel',
    'chooseScope', 'targets', 'configureTargets', 'retry'];
  if (simple.includes(value.type)) return { type: value.type } as Message;
  if (value.type === 'details') {
    if (typeof value.id !== 'string' || (value.scopeKey !== undefined && typeof value.scopeKey !== 'string')) throw new Error('Invalid package details request.');
    return { type: 'details', id: value.id, ...(typeof value.scopeKey === 'string' ? { scopeKey: value.scopeKey } : {}) };
  }
  if (value.type === 'workflow' && typeof value.workflow === 'string' && isWorkflow(value.workflow)) return { type: 'workflow', workflow: value.workflow };
  const stringFields: Record<string, string> = { scope: 'key', filters: 'search', external: 'url', navigate: 'id', openTarget: 'target' };
  const field = stringFields[value.type];
  if (field && typeof value[field] === 'string') return { type: value.type, [field]: value[field] } as Message;
  if (value.type === 'packageAction' && packageActions.includes(value.action as PackageAction)) return { type: 'packageAction', action: value.action as PackageAction };
  throw new Error('Unknown or malformed webview request.');
}

export function scopeKey(scope: Scope): string { return `${scope.kind}:${scope.path}`; }
export function isSameScope(a: Scope, b: Scope): boolean { return scopeKey(a) === scopeKey(b); }
/** True only when the item carries a scope equal to `scope`; unscoped items never match. */
export function inScope(item: { scope?: Scope }, scope: Scope): boolean { return !!item.scope && isSameScope(item.scope, scope); }
export function scopeKindLabel(scope: Scope): string { return scope.kind === 'global' ? 'Global' : 'Workspace'; }
/** `compact` drops the "(user)" qualifier for tags and buttons. */
export function scopeLabel(scope: Scope, compact = false): string {
  return scope.kind === 'global' ? compact ? 'Global' : 'Global (user)' : `Workspace: ${scope.label}`;
}
