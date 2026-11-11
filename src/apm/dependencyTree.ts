export interface DependencyTreeNode {
  label: string;
  packageName?: string;
  children: DependencyTreeNode[];
}

export function parseDependencyTree(text: string): DependencyTreeNode {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  const rootLabel = lines.shift()?.trim();
  if (!rootLabel) throw new Error('APM returned an empty dependency tree.');
  const root: DependencyTreeNode = { label: rootLabel, children: [] };
  const parents: DependencyTreeNode[] = [root];
  for (const line of lines) {
    const match = /^((?:│[\x20]{3}|[\x20]{4})*)(?:├──[\x20]|└──[\x20])(.*)$/.exec(line);
    if (!match || !match[2].trim()) throw new Error('APM returned an unrecognized dependency tree format.');
    const depth = match[1].length / 4 + 1;
    const parent = parents[depth - 1];
    if (!parent) throw new Error('APM returned an invalid dependency tree hierarchy.');
    const label = match[2].trim();
    const at = label.lastIndexOf('@');
    const packageName = at > label.lastIndexOf('/') ? label.slice(0, at) : undefined;
    const node: DependencyTreeNode = { label, ...(packageName ? { packageName } : {}), children: [] };
    parent.children.push(node);
    parents.length = depth;
    parents[depth] = node;
  }
  return root;
}
