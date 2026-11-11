import * as vscode from 'vscode';
import { parseDependencyTree, type DependencyTreeNode } from './apm/dependencyTree';

export class DependencyTreeItem extends vscode.TreeItem {
  constructor(
    readonly node: DependencyTreeNode,
    readonly scopeKey: string
  ) {
    super(node.label, node.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    if (node.packageName) this.contextValue = 'apmDependencyPackage';
  }
}

export class DependencyTreeProvider implements vscode.TreeDataProvider<DependencyTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<DependencyTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private root?: DependencyTreeItem;

  getTreeItem(item: DependencyTreeItem): vscode.TreeItem { return item; }

  getChildren(item?: DependencyTreeItem): DependencyTreeItem[] {
    if (item) return item.node.children.map(child => new DependencyTreeItem(child, item.scopeKey));
    return this.root ? [this.root] : [];
  }

  setTree(output: string, scopeKey: string, scopeLabel: string) {
    const parsed = parseDependencyTree(output);
    parsed.label = `${scopeLabel}: ${parsed.label}`;
    this.root = new DependencyTreeItem(parsed, scopeKey);
    this.changeEmitter.fire(undefined);
  }

  clear() {
    this.root = undefined;
    this.changeEmitter.fire(undefined);
  }

  dispose() { this.changeEmitter.dispose(); }
}
