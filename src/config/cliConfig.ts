import { containsUrlCredentials } from '../apm/redact';

/** `apm config` keys mirrored as `apm.config.*` settings. Self-update keys are intentionally excluded. */
export interface CliSetting {
  setting: string;
  key: string;
  file: string;
  type: 'boolean' | 'string' | 'list';
  default: boolean | string | string[];
}

export const cliSettings: readonly CliSetting[] = [
  { setting: 'config.autoIntegrate', key: 'auto-integrate', file: 'auto_integrate', type: 'boolean', default: true },
  { setting: 'config.target', key: 'target', file: 'install_target', type: 'list', default: [] },
  { setting: 'config.preferSsh', key: 'prefer-ssh', file: 'prefer_ssh', type: 'boolean', default: false },
  { setting: 'config.allowProtocolFallback', key: 'allow-protocol-fallback', file: 'allow_protocol_fallback', type: 'boolean', default: false },
  { setting: 'config.mcpRegistryUrl', key: 'mcp-registry-url', file: 'mcp_registry_url', type: 'string', default: '' },
  { setting: 'config.tempDir', key: 'temp-dir', file: 'temp_dir', type: 'string', default: '' }
];

export type CliValue = boolean | string | string[];

export function normalize(definition: CliSetting, value: unknown): CliValue {
  switch (definition.type) {
    case 'boolean':
      if (value === undefined) return definition.default;
      if (typeof value !== 'boolean') throw new Error(`APM config ${definition.key} must be a boolean.`);
      return value;
    case 'string':
      if (value === undefined) return '';
      if (typeof value !== 'string') throw new Error(`APM config ${definition.key} must be a string.`);
      if (definition.key === 'mcp-registry-url' && containsUrlCredentials(value)) {
        throw new Error('Do not put credentials in the MCP registry URL. Remove them and use APM authentication.');
      }
      return value.trim();
    case 'list': {
      if (value === undefined) return [];
      const items: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [value];
      if (items.some(item => typeof item !== 'string')) throw new Error(`APM config ${definition.key} must contain only strings.`);
      return [...new Set(items.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
    }
  }
}

export function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }

/** An explicit setting wins initially; otherwise import the existing CLI value. */
export function direction(setting: CliValue, file: CliValue, last: unknown, configured = false): 'none' | 'push' | 'pull' {
  if (same(setting, file)) return 'none';
  return last === undefined ? configured ? 'push' : 'pull' : !same(setting, last) ? 'push' : 'pull';
}

export function pushArguments(definition: CliSetting, value: CliValue): string[] {
  if (definition.type === 'boolean') return ['config', 'set', definition.key, String(value)];
  const text = Array.isArray(value) ? value.join(',') : String(value);
  return text ? ['config', 'set', definition.key, text] : ['config', 'unset', definition.key];
}

/** Setting value to store; defaults are removed from settings.json rather than written explicitly. */
export function settingValue(definition: CliSetting, value: CliValue): CliValue | undefined {
  return same(value, definition.default) ? undefined : value;
}
