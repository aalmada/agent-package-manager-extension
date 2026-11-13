import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDependencyTree } from '../../src/apm/dependencyTree';

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
