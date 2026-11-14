import type { PackageItem } from './types';
import { record } from './adapters';

export interface DependencyTreeNode {
  label: string;
  /** Lockfile identity from a `key@version` label; summary rows such as "16 skills" have none. */
  packageName?: string;
  version?: string;
  /** `circular` repeats an ancestor; `unresolved` could not be placed under its parent. */
  note?: 'circular' | 'unresolved';
  children: DependencyTreeNode[];
}

const notes: [string, NonNullable<DependencyTreeNode['note']>][] = [
  [' (circular)', 'circular'],
  [' (could not place in tree; run apm install to resolve)', 'unresolved']
];

/** Parses `apm deps tree` output in Rich (box-drawing) or plain ASCII form. */
export function parseDependencyTree(text: string): DependencyTreeNode {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  const rootLabel = lines.shift()?.trim();
  if (!rootLabel) throw new Error('APM returned an empty dependency tree.');
  const root: DependencyTreeNode = { label: rootLabel, children: [] };
  const parents: DependencyTreeNode[] = [root];
  for (const line of lines) {
    const match = /^((?:[│|][\x20]{3}|[\x20]{4})*)(?:├──[\x20]|└──[\x20]|\|--[\x20]|\+--[\x20])(.*)$/.exec(line);
    if (!match || !match[2].trim()) throw new Error('APM returned an unrecognized dependency tree format.');
    const depth = match[1].length / 4 + 1;
    const parent = parents[depth - 1];
    if (!parent) throw new Error('APM returned an invalid dependency tree hierarchy.');
    let label = match[2].trim();
    const suffix = notes.find(([text]) => label.endsWith(text));
    if (suffix) label = label.slice(0, -suffix[0].length);
    // Replacement pins render as `key@version -> source`; the identity precedes the arrow.
    const reference = label.split(' -> ')[0];
    const at = reference.lastIndexOf('@');
    const packageName = at > 0 && at > reference.lastIndexOf('/') ? reference.slice(0, at) : undefined;
    const node: DependencyTreeNode = {
      label, ...(packageName ? { packageName, version: reference.slice(at + 1) } : {}), ...(suffix ? { note: suffix[1] } : {}), children: []
    };
    parent.children.push(node);
    parents.length = depth;
    parents[depth] = node;
  }
  return root;
}

/** Finds the installed package a tree node names; `items` must belong to the tree's scope. */
export function dependencyTreeItem(packageName: string, items: readonly PackageItem[]): PackageItem | undefined {
  const matches = items.filter(item => {
    const lock = record(item.metadata?.lock) ? item.metadata.lock : undefined;
    return [item.metadata?.lockIdentity, lock?.local_path, item.metadata?.cliIdentity].includes(packageName);
  });
  return matches.length === 1 ? matches[0] : undefined;
}
