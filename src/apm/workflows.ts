import { record } from './adapters';

export interface ResolvedTarget {
  target: string;
  status: string;
  source: string;
  deployDir?: string;
  needs?: string;
}
export interface CommandRequest {
  type: 'command';
  id: string;
  args: Record<string, string>;
  options: Record<string, unknown>;
}

export function resolvedTargets(text: string): ResolvedTarget[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('Unrecognized APM target report: expected an array.');
  return parsed.map(value => {
    if (!record(value) || typeof value.target !== 'string' || typeof value.status !== 'string' ||
      (value.source !== null && typeof value.source !== 'string') || (value.deploy_dir != null && typeof value.deploy_dir !== 'string') ||
      (value.needs != null && typeof value.needs !== 'string')) {
      throw new Error('Unrecognized APM target row. Review APM Output.');
    }
    return { target: value.target, status: value.status, source: value.source ?? 'No activation source reported',
      ...(typeof value.deploy_dir === 'string' ? { deployDir: value.deploy_dir } : {}),
      ...(typeof value.needs === 'string' ? { needs: value.needs } : {}) };
  });
}

export const workflowCommands = {
  initialize: { id: 'init', options: {} },
  previewInstall: { id: 'install', options: { '--dry-run': true } },
  compile: { id: 'compile', options: {} },
  previewCompile: { id: 'compile', options: { '--dry-run': true } },
  validate: { id: 'compile', options: { '--validate': true } },
  auditWorkspace: { id: 'audit', options: { '--format': 'json' } },
  doctor: { id: 'doctor', options: {} },
  runScript: { id: 'run', options: {} },
  policy: { id: 'policy explain', options: {} }
} satisfies Record<string, { id: string; options: Record<string, unknown> }>;
export type Workflow = keyof typeof workflowCommands;
export function isWorkflow(value: string): value is Workflow { return Object.hasOwn(workflowCommands, value); }

export type Recovery = 'doctor' | 'authentication' | 'policy' | 'targets' | 'retry' | 'output';
export function recoveryActions(message: string): Recovery[] {
  const actions: Recovery[] = ['output', 'doctor'];
  if (/\b(?:401|403|404)\b|authentication failed|could not read username|permission denied \(publickey\)|repository not found|no marketplace\.json found/i.test(message)) actions.push('authentication');
  if (/policy (?:denied|violation|blocked)|blocked by.*policy|executable trust/i.test(message)) actions.push('policy');
  if (/no (?:active |detected )?targets|no harness|zero output/i.test(message)) actions.push('targets');
  return actions;
}
