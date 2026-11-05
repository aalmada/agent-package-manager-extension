import type { CommandDescriptor, Marketplace, PackageItem, Scope } from './apm/types';
import { record } from './apm/adapters';
import { packageActions, type ActionResult, type PackageAction } from './apm/actions';

export type Mode = 'browser' | 'details' | 'tools';
export interface State {
  mode: Mode;
  trusted: boolean;
  scopes: Scope[];
  scopeKey: string;
  version?: string;
  warning?: string;
  error?: string;
  errors: string[];
  busy: boolean;
  checkedAt?: string;
  catalog: PackageItem[];
  installed: PackageItem[];
  marketplaces: Marketplace[];
  commands: CommandDescriptor[];
  availableCommands: string[];
  selectedCommand?: string;
  commandRequest?: number;
  commandArgs?: Record<string, string>;
  commandOptions?: Record<string, unknown>;
  result?: string;
  item?: PackageItem;
  details?: Record<string, unknown>;
  readmeHtml?: string;
  readmeImagesBlocked?: { https: boolean; insecure: boolean };
  actionResult?: ActionResult;
}
export type Message =
  | { type: 'ready' | 'refresh' | 'tools' | 'marketplaces' | 'setup' | 'output' | 'trust' | 'settings' | 'readmeImageSettings' | 'cancel' }
  | { type: 'scope'; key: string }
  | { type: 'filters'; search: string }
  | { type: 'details'; id: string }
  | { type: 'command'; id: string; args: Record<string, string>; options: Record<string, unknown> }
  | { type: 'selectCommand'; id: string; args?: Record<string, string>; options?: Record<string, unknown> }
  | { type: 'help'; id: string }
  | { type: 'packageAction'; action: PackageAction }
  | { type: 'external'; url: string };

export function parseMessage(value: unknown): Message {
  if (!record(value) || typeof value.type !== 'string') throw new Error('Invalid webview message.');
  const simple = ['ready', 'refresh', 'tools', 'marketplaces', 'setup', 'output', 'trust', 'settings', 'readmeImageSettings', 'cancel'];
  if (simple.includes(value.type)) return { type: value.type } as Message;
  const stringFields: Record<string, string> = { scope: 'key', filters: 'search', details: 'id', help: 'id', external: 'url' };
  const field = stringFields[value.type];
  if (field && typeof value[field] === 'string') return { type: value.type, [field]: value[field] } as Message;
  if (value.type === 'packageAction' && packageActions.includes(value.action as PackageAction)) return { type: 'packageAction', action: value.action as PackageAction };
  if (['command', 'selectCommand'].includes(value.type) && typeof value.id === 'string') {
    const args = value.args ?? {}, options = value.options ?? {};
    if (!record(args) || Object.values(args).some(x => typeof x !== 'string') || !record(options) ||
      Object.values(options).some(x => !['boolean', 'string', 'number'].includes(typeof x))) throw new Error('Invalid command fields.');
    return { type: value.type, id: value.id, args: args as Record<string, string>, options } as Message;
  }
  throw new Error('Unknown or malformed webview request.');
}

export function scopeKey(scope: Scope): string { return `${scope.kind}:${scope.path}`; }
