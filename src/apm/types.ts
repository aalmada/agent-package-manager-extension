export interface Scope { kind: 'workspace' | 'global'; path: string; label: string }
export type UpdateStatus = 'unchecked' | 'checking' | 'current' | 'outdated' | 'unknown' | 'not-comparable' | 'failed';
export interface PackageItem {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  description?: string;
  installed: boolean;
  scope?: Scope;
  installations?: PackageItem[];
  direct?: boolean;
  updateStatus?: UpdateStatus;
  latestVersion?: string;
  updateStale?: boolean;
  source?: string;
  metadata?: Record<string, unknown>;
}
export interface Marketplace {
  name: string;
  source: string;
  ref?: string;
  host?: string;
  [key: string]: unknown;
}
export interface CommandOption {
  name: string;
  label: string;
  type: 'boolean' | 'string' | 'number' | 'choice';
  aliases?: string[];
  choices?: string[];
  caseSensitive?: boolean;
  required?: boolean;
  repeatable?: boolean;
  nargs?: number;
  at?: number;
  negative?: string;
  optionalValue?: boolean;
  hidden?: boolean;
  description?: string;
  default?: string | number | boolean;
}
export interface CommandArgument { name: string; label: string; required: boolean; variadic?: boolean; at?: number }
export interface CommandDescriptor {
  id: string;
  label: string;
  category: string;
  command: string[];
  description: string;
  options: CommandOption[];
  positionals: CommandArgument[];
  global?: boolean;
  mutates: boolean;
  interactive?: boolean;
  experimental?: boolean;
  experimentalFeature?: string;
  deprecated?: boolean;
}
export interface ExecutionResult { stdout: string; stderr: string; exitCode: number }
export interface Probe { version: string; commands: string[]; warning?: string }
export interface UpdateRow { package: string; current: string; latest: string; wanted?: string; status: UpdateStatus; source: string }
