import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dependencyTreeItem, parseDependencyTree } from '../../src/apm/dependencyTree';

test('dependency tree parser retains hierarchy and package identities', () => {
  const tree = parseDependencyTree([
    'project (local)',
    '├── owner/first@1.2.0',
    '│   ├── owner/child@2.0.0',
    '│   └── 16 skills',
    '└── owner/second@main'
  ].join('\n'));
  assert.equal(tree.label, 'project (local)');
  assert.deepEqual(tree.children.map(node => node.packageName), ['owner/first', 'owner/second']);
  assert.equal(tree.children[0].children[0].packageName, 'owner/child');
  assert.equal(tree.children[0].children[1].label, '16 skills');
  assert.equal(tree.children[0].children[1].packageName, undefined);
});

test('dependency tree parser reports empty and malformed CLI output', () => {
  assert.throws(() => parseDependencyTree(' \n'), /empty dependency tree/);
  assert.throws(() => parseDependencyTree('project\nnot a branch'), /unrecognized dependency tree format/);
  assert.throws(() => parseDependencyTree('project\n│   └── orphan'), /invalid dependency tree hierarchy/);
});

test('dependency tree parser reads APM notes, replacement pins and the ASCII fallback', () => {
  const tree = parseDependencyTree([
    'project (local)',
    '|-- owner/first@1.2.0 -> fork/first@abc1234',
    '|   +-- owner/first@1.2.0 (circular)',
    '+-- packages/local@latest (could not place in tree; run apm install to resolve)'
  ].join('\n'));
  const [first, local] = tree.children;
  assert.deepEqual([first.packageName, first.version, first.note], ['owner/first', '1.2.0', undefined]);
  assert.deepEqual([first.children[0].label, first.children[0].note], ['owner/first@1.2.0', 'circular']);
  assert.deepEqual([local.packageName, local.version, local.note], ['packages/local', 'latest', 'unresolved']);
});

test('dependency tree items match unique lock identities, local paths and CLI identities', () => {
  const item = (id: string, metadata: Record<string, unknown>) => ({ id, name: id, marketplace: '', version: '1', installed: true, metadata });
  const items = [
    item('remote', { lockIdentity: 'owner/remote' }),
    item('local', { lockIdentity: 'local:packages/local', lock: { local_path: 'packages/local' } }),
    item('alias', { cliIdentity: 'alias' }),
    item('first-duplicate', { lockIdentity: 'owner/duplicate' }),
    item('second-duplicate', { lockIdentity: 'owner/duplicate' })
  ];
  assert.equal(dependencyTreeItem('owner/remote', items)?.id, 'remote');
  assert.equal(dependencyTreeItem('packages/local', items)?.id, 'local');
  assert.equal(dependencyTreeItem('alias', items)?.id, 'alias');
  assert.equal(dependencyTreeItem('owner/duplicate', items), undefined);
  assert.equal(dependencyTreeItem('owner/missing', items), undefined);
});
