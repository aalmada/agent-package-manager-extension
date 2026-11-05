import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descriptors, buildCommandArguments, requiresTerminal } from '../../src/apm/commands';

test('baseline contains every command family and nested marketplace workflow', () => {
  const expected = ['approve', 'audit', 'auth', 'cache', 'compile', 'config', 'deny', 'deps', 'doctor', 'experimental', 'find', 'init', 'install', 'lifecycle', 'list', 'lock', 'marketplace', 'mcp', 'outdated', 'pack', 'plugin', 'policy', 'preview', 'prune', 'publish', 'run', 'runtime', 'search', 'self-update', 'targets', 'uninstall', 'unpack', 'update', 'view'];
  assert.deepEqual([...new Set(descriptors.map(d => d.command[0]))].sort(), expected.sort());
  for (const id of ['marketplace add', 'marketplace list', 'marketplace browse', 'marketplace update', 'marketplace remove', 'marketplace validate', 'marketplace init', 'marketplace migrate', 'marketplace check', 'marketplace audit', 'marketplace outdated', 'marketplace package add', 'marketplace package set', 'marketplace package remove']) assert.ok(descriptors.some(d => d.id === id), id);
  assert.equal(new Set(descriptors.map(d => d.id)).size, descriptors.length);
  assert.equal(descriptors.length, 75);
});
test('terminal routing follows the contract and keeps confirmed runtime removal in the visual result', () => {
  const command = (id: string) => {
    const descriptor = descriptors.find(d => d.id === id);
    assert.ok(descriptor, id);
    return descriptor;
  };
  for (const id of ['auth', 'run', 'runtime setup']) {
    assert.equal(command(id).interactive, true, id);
    assert.equal(requiresTerminal(command(id), {}), true, id);
  }
  for (const id of ['runtime list', 'runtime status']) {
    assert.equal(command(id).interactive, false, id);
    assert.equal(requiresTerminal(command(id), {}), false, id);
  }
  assert.equal(command('runtime remove').interactive, true);
  assert.equal(requiresTerminal(command('runtime remove'), {}), true);
  assert.equal(requiresTerminal(command('runtime remove'), { '--yes': false }), true);
  assert.equal(requiresTerminal(command('runtime remove'), { '--yes': true }), false);
  assert.equal(requiresTerminal({ ...command('runtime list'), id: 'future interactive', interactive: true }, {}), true);
});
test('marketplace command arguments retain whitespace and shell metacharacters without interpolation', () => {
  const descriptor = descriptors.find(d => d.id === 'marketplace add')!;
  assert.deepEqual(buildCommandArguments(descriptor, { source: '/tmp/my marketplace;echo ignored' }, { '--name': 'my-market', '--ref': 'v1.0.0' }), ['marketplace', 'add', '--name', 'my-market', '--ref', 'v1.0.0', '/tmp/my marketplace;echo ignored']);
  assert.throws(() => buildCommandArguments(descriptor, { source: '--malicious' }, {}), /Invalid/);
  assert.throws(() => buildCommandArguments(descriptor, {}, {}), /required/);
  assert.throws(() => buildCommandArguments(descriptor, { source: 'owner/repo' }, { '--unknown': true }), /Unknown/);
});
test('group flags are placed before nested subcommands', () => {
  const descriptor = descriptors.find(d => d.id === 'lock export')!;
  const args = buildCommandArguments(descriptor, {}, { '--target': 'copilot', '--global': true, '--format': 'json' });
  assert.ok(args.indexOf('--target') < args.indexOf('export'));
  assert.ok(args.indexOf('--global') > args.indexOf('export'));
  assert.ok(args.indexOf('--format') > args.indexOf('export'));
});
test('repeatable values, optional-value flags and global root options preserve semantics', () => {
  assert.deepEqual(buildCommandArguments(descriptors.find(d => d.id === 'install')!, {}, {}), ['install']);
  const run = descriptors.find(d => d.id === 'run')!;
  assert.deepEqual(buildCommandArguments(run, { script_name: 'review' }, { '--param': 'name=first value\nother=second' }), ['run', '--param', 'name=first value', '--param', 'other=second', 'review']);
  const view = descriptors.find(d => d.id === 'view')!;
  assert.deepEqual(buildCommandArguments(view, { package: 'org/repo', field: 'versions' }, { '--registry': true }), ['view', '--registry', 'org/repo', 'versions']);
  const cache = descriptors.find(d => d.id === 'cache info')!;
  assert.equal(buildCommandArguments(cache, {}, { '--verbose': true })[0], '--verbose');
});
test('every command validates required positionals and has typed uniquely named options', () => {
  for (const descriptor of descriptors) {
    assert.equal(new Set(descriptor.options.map(o => o.name)).size, descriptor.options.length, descriptor.id);
    for (const option of descriptor.options) assert.ok(option.name.startsWith('-'), `${descriptor.id} ${option.name}`);
    for (const argument of descriptor.positionals.filter(a => a.required)) {
      assert.throws(() => buildCommandArguments(descriptor, {}, {}), /required/, `${descriptor.id} ${argument.name}`);
    }
  }
});
