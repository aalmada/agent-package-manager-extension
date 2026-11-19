import type { CommandDescriptor, Marketplace, PackageItem, Scope } from './apm/types';
import { record } from './apm/adapters';
import { packageActions, type ActionResult, type PackageAction } from './apm/actions';
import { isWorkflow, type Workflow, type ResolvedTarget } from './apm/workflows';
import type { DependencyTreeNode } from './apm/dependencyTree';

/** `gallery` is the large package browser list; its details pages use `details` with `gallery` set. */
export type Mode = 'browser' | 'details' | 'gallery';
export const browserSections = ['catalog', 'installed', 'updates', 'direct', 'transitive', 'unclassified'] as const;
export type BrowserSection = typeof browserSections[number];
export type PackageSection = Extract<BrowserSection, 'catalog' | 'installed' | 'updates'>;
/** A dependency tree loaded into the package browser window for one scope. */
export interface DependencyTreeView {
  root?: DependencyTreeNode;
  loading?: boolean;
  error?: string;
  /** Installed packages in the scope changed after the tree was loaded. */
  stale?: boolean;
}
export interface State {
  mode: Mode;
  gallery?: boolean;
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
  /** Keyed by scope key; only the package browser window loads trees. */
  dependencyTrees?: Record<string, DependencyTreeView>;
}
export type Message =
  | { type: 'ready' | 'refresh' | 'install' | 'updateAll' | 'dependencies' | 'actions' | 'marketplaces' | 'setup' | 'output' | 'trust' | 'settings' | 'readmeImageSettings' | 'cancel' | 'chooseScope' | 'targets' | 'configureTargets' | 'retry' | 'back' }
  | { type: 'scope'; key: string }
  /** Without `scopeKey`, or outside the package browser window, opens the text report for the page's scope. */
  | { type: 'dependencyTree'; scopeKey?: string }
  | { type: 'dependencyTreeText'; scopeKey: string }
  | { type: 'filters'; search: string }
  | { type: 'details'; id: string; scopeKey?: string }
  | { type: 'dependencyWhy'; id: string; scopeKey: string }
  | { type: 'packageAction'; action: PackageAction }
  | { type: 'external'; url: string }
  | { type: 'workflow'; workflow: Workflow }
  | { type: 'navigate'; id: string }
  | { type: 'openTarget'; target: string };

export function parseMessage(value: unknown): Message {
  if (!record(value) || typeof value.type !== 'string') throw new Error('Invalid webview message.');
  const simple = ['ready', 'refresh', 'install', 'updateAll', 'dependencies', 'actions', 'marketplaces', 'setup', 'output', 'trust', 'settings', 'readmeImageSettings', 'cancel',
    'chooseScope', 'targets', 'configureTargets', 'retry', 'back'];
  if (simple.includes(value.type)) return { type: value.type } as Message;
  if (value.type === 'dependencyTree') {
    if (value.scopeKey !== undefined && typeof value.scopeKey !== 'string') throw new Error('Invalid dependency tree request.');
    return { type: 'dependencyTree', ...(typeof value.scopeKey === 'string' ? { scopeKey: value.scopeKey } : {}) };
  }
  if (value.type === 'dependencyTreeText' && typeof value.scopeKey === 'string') return { type: 'dependencyTreeText', scopeKey: value.scopeKey };
  if (value.type === 'dependencyWhy' && typeof value.id === 'string' && typeof value.scopeKey === 'string') {
    return { type: 'dependencyWhy', id: value.id, scopeKey: value.scopeKey };
  }
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
