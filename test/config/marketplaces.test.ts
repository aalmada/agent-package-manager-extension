import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addArguments, defaultName, entryText, legacyEntry, location, matches, parseEntry, planSync, resolvedText } from '../../src/config/marketplaces';
import { cliSettings, direction, normalize, pushArguments, settingValue } from '../../src/config/cliConfig';
import { parseMessage } from '../../src/protocol';
import type { Marketplace } from '../../src/apm/types';

const gh = (owner: string, repo: string, extra: Partial<Marketplace> = {}): Marketplace =>
  ({ name: repo, source: `https://github.com/${owner}/${repo}`, url: `https://github.com/${owner}/${repo}`, owner, repo, host: 'github.com', ref: 'main', ...extra });

test('marketplace entries accept the chat marketplace syntax plus APM name and marketplace.json forms', () => {
  assert.deepEqual(addArguments(parseEntry('github/awesome-copilot')), ['marketplace', 'add', 'github/awesome-copilot']);
  assert.deepEqual(addArguments(parseEntry('owner/repo#v1.2')), ['marketplace', 'add', 'owner/repo', '--ref', 'v1.2']);
  assert.deepEqual(addArguments(parseEntry('https://git.example.com/team/catalog.git#release')), ['marketplace', 'add', 'https://git.example.com/team/catalog.git', '--ref', 'release']);
  assert.deepEqual(addArguments(parseEntry('ssh://git@host:2222/org/repo.git#dev')), ['marketplace', 'add', 'ssh://git@host:2222/org/repo.git', '--ref', 'dev']);
  assert.deepEqual(addArguments(parseEntry('custom=git@host:org/repo.git#v2')), ['marketplace', 'add', 'git@host:org/repo.git', '--name', 'custom', '--ref', 'v2']);
  assert.deepEqual(addArguments(parseEntry('catalog=https://catalog.example.com/marketplace.json')), ['marketplace', 'add', 'https://catalog.example.com/marketplace.json', '--name', 'catalog']);
  assert.deepEqual(addArguments(parseEntry('gitlab.com/group/repo')), ['marketplace', 'add', 'gitlab.com/group/repo']);
  assert.deepEqual(addArguments(parseEntry('~/code/market')), ['marketplace', 'add', join(homedir(), 'code/market')]);
  assert.deepEqual(addArguments(parseEntry('/tmp/a marketplace')), ['marketplace', 'add', '/tmp/a marketplace']);
  assert.deepEqual(addArguments(parseEntry('local=/tmp/a marketplace')), ['marketplace', 'add', '/tmp/a marketplace', '--name', 'local']);
  const local = join(homedir(), 'a#b');
  assert.deepEqual(addArguments(parseEntry(pathToFileURL(local).href)), ['marketplace', 'add', local]);
  assert.throws(() => parseEntry('./vendor'), /exactly one local workspace/);
  const relative = parseEntry('named=./vendor', join(homedir(), 'project'));
  assert.deepEqual(addArguments(relative), ['marketplace', 'add', join(homedir(), 'project', 'vendor'), '--name', 'named']);
  assert.equal(resolvedText(relative), `named=${pathToFileURL(join(homedir(), 'project', 'vendor')).href}`);
  assert.deepEqual(addArguments(parseEntry(`${pathToFileURL(local).href}#release%2Fstable`)),
    ['marketplace', 'add', local, '--ref', 'release/stable']);
  assert.throws(() => parseEntry('--evil'), /not a valid/);
  assert.throws(() => parseEntry('named=-evil'), /not a valid/);
  assert.throws(() => parseEntry('owner/repo#'), /empty/);
  assert.throws(() => parseEntry('https://x.example/marketplace.json#v1'), /do not accept/);
  assert.throws(() => parseEntry('https://%'), /not a valid/);
  assert.throws(() => parseEntry('https://user:secret@host/org/repo.git'), /passwords/);
});

test('marketplace and MCP settings reject URL credentials without importing unsafe registrations', () => {
  for (const source of ['https://example-user@host.test/org/repo', 'named=HTTP://example-user@host.test/repo', 'ssh://git:example-value@host.test/repo']) {
    assert.throws(() => parseEntry(source), /passwords or access tokens/);
  }
  const registered: Marketplace[] = [{ name: 'unsafe', source: 'https://example-user@host.test/org/repo' }];
  assert.throws(() => planSync([], registered, {}), /Remove or replace that registration/);
  const registry = cliSettings.find(setting => setting.key === 'mcp-registry-url')!;
  assert.throws(() => normalize(registry, 'https://example-user@host.test/registry'), /Do not put credentials/);
  assert.equal(normalize(registry, 'https://host.test/registry'), 'https://host.test/registry');
});

test('non-GitHub hosts, non-default ports and JSON URLs retain distinct source identities', () => {
  assert.notEqual(location('ssh://git@git.example.com:2222/Team/Repo.git'), location('ssh://git@git.example.com/Team/Repo.git'));
  assert.notEqual(location('https://git.example.com/Team/Repo'), location('https://git.example.com/team/repo'));
  assert.notEqual(location('http://catalog.example/marketplace.json'), location('https://catalog.example/marketplace.json'));
  assert.notEqual(location('https://catalog.example/marketplace.json?channel=one'), location('https://catalog.example/marketplace.json?channel=two'));
});

test('equivalent spellings of one source normalize to the same location', () => {
  for (const spelling of ['github/awesome-copilot', 'https://github.com/github/awesome-copilot.git', 'git@github.com:github/awesome-copilot.git', 'ssh://git@github.com/github/Awesome-Copilot', 'github.com/github/awesome-copilot/']) {
    assert.equal(location(spelling), 'github.com/github/awesome-copilot', spelling);
  }
  assert.ok(matches(parseEntry('github/awesome-copilot'), gh('github', 'awesome-copilot')));
  assert.ok(matches(parseEntry('Awesome-Copilot=github/awesome-copilot'), gh('github', 'awesome-copilot')));
  assert.ok(!matches(parseEntry('git@github.com:github/awesome-copilot.git'), gh('github', 'awesome-copilot')));
  assert.ok(!matches(parseEntry('github/awesome-copilot#v2'), gh('github', 'awesome-copilot')));
  assert.ok(!matches(parseEntry('other=github/awesome-copilot'), gh('github', 'awesome-copilot')));
});

test('registrations round-trip through their setting text', () => {
  const localMarket = pathToFileURL(join(homedir(), 'market')).href;
  const localRepo = pathToFileURL(join(homedir(), 'repo')).href;
  const registered: Marketplace[] = [
    gh('github', 'awesome-copilot'), gh('docker', 'skills', { name: 'docker' }), gh('dotnet', 'skills', { ref: 'v2' }),
    gh('team', 'private', { source: 'git@github.com:team/private.git', ref: 'release' }),
    { name: 'x', source: localMarket, url: localMarket, ref: 'main' },
    { name: '_local', source: localRepo, ref: 'release/stable' },
    { name: 'catalog', source: 'https://catalog.example.com/marketplace.json', ref: 'main' }
  ];
  assert.deepEqual(registered.map(entryText), ['github/awesome-copilot', 'docker=docker/skills', 'dotnet/skills#v2', 'git@github.com:team/private.git#release', `x=${localMarket}`, `_local=${localRepo}#release%2Fstable`, 'catalog=https://catalog.example.com/marketplace.json']);
  for (const marketplace of registered) assert.ok(matches(parseEntry(entryText(marketplace)), marketplace), marketplace.name);
});

test('legacy declarations retain names, hosts, refs and relative paths when migrated', () => {
  const root = join(homedir(), 'project');
  assert.equal(legacyEntry({ source: 'team/catalog', name: 'internal', host: 'git.example.com', ref: 'release' }),
    'internal=git.example.com/team/catalog#release');
  assert.equal(legacyEntry({ source: './vendor', branch: 'release/stable' }, root),
    `${pathToFileURL(join(root, 'vendor')).href}#release%2Fstable`);
  assert.throws(() => legacyEntry({ source: './vendor' }), /exactly one local workspace/);
  assert.throws(() => legacyEntry({ source: 'owner/repo', ref: 'a', branch: 'b' }), /cannot both/);
  assert.throws(() => legacyEntry({ source: 'owner/repo', name: 'invalid/name' }), /name is invalid/);
  assert.equal(defaultName(parseEntry('/tmp/a marketplace')), 'a-marketplace');
});

test('first sync imports existing registrations without running APM', () => {
  const plan = planSync([], [gh('github', 'awesome-copilot'), gh('docker', 'skills', { name: 'docker' })], {});
  assert.deepEqual(plan.setting, ['github/awesome-copilot', 'docker=docker/skills']);
  assert.deepEqual(plan.links, { 'github/awesome-copilot': 'awesome-copilot', 'docker=docker/skills': 'docker' });
  assert.deepEqual([plan.add, plan.remove], [[], []]);
});

test('sync adds new items, removes deleted items and mirrors registry changes made outside VS Code', () => {
  const links = { 'github/awesome-copilot': 'awesome-copilot', 'docker=docker/skills': 'docker', 'gone/repo': 'repo' };
  const registered = [gh('github', 'awesome-copilot'), gh('docker', 'skills', { name: 'docker' }), gh('cli', 'added')];
  const plan = planSync(['github/awesome-copilot', 'gone/repo', 'dotnet/skills', 'bad entry'], registered, links);
  assert.deepEqual(plan.add.map(e => e.text), ['dotnet/skills']);
  assert.deepEqual(plan.remove, ['docker']);
  assert.deepEqual(plan.setting, ['github/awesome-copilot', 'dotnet/skills', 'bad entry', 'cli/added']);
  assert.equal(plan.invalid.length, 1);
  assert.deepEqual(plan.links, { 'github/awesome-copilot': 'awesome-copilot', 'cli/added': 'added' });
});

test('changing the ref of an item replaces the registration; respelling it does not', () => {
  const links = { 'owner/repo': 'repo' }, registered = [gh('owner', 'repo')];
  const changed = planSync(['owner/repo#v2'], registered, links);
  assert.deepEqual([changed.remove, changed.add.map(e => e.text)], [['repo'], ['owner/repo#v2']]);
  const respelled = planSync(['https://github.com/owner/repo.git'], registered, links);
  assert.deepEqual([respelled.remove, respelled.add, respelled.links], [[], [], { 'https://github.com/owner/repo.git': 'repo' }]);
  const transportChanged = planSync(['git@github.com:owner/repo.git'], registered, links);
  assert.deepEqual([transportChanged.remove, transportChanged.add.map(e => e.text)], [['repo'], ['git@github.com:owner/repo.git']]);
});

test('external changes to a registration with the same name are mirrored into the setting', () => {
  const links = { 'owner/repo': 'repo' };
  const updated = planSync(['owner/repo'], [gh('owner', 'repo', { ref: 'release' })], links);
  assert.deepEqual(updated.setting, ['owner/repo#release']);
  assert.deepEqual(updated.links, { 'owner/repo#release': 'repo' });
  assert.deepEqual([updated.add, updated.remove], [[], []]);
});

test('duplicate and previously failed entries are not added again', () => {
  const plan = planSync(['owner/repo', 'https://github.com/owner/repo', 'other/one'], [], {}, new Set(['other/one']));
  assert.deepEqual(plan.add.map(e => e.text), ['owner/repo']);
  assert.deepEqual(plan.setting, ['owner/repo', 'https://github.com/owner/repo', 'other/one']);
});

test('CLI configuration keys exclude self-update and map values in both directions', () => {
  assert.ok(!cliSettings.some(s => s.key.startsWith('self-update')));
  const target = cliSettings.find(s => s.key === 'target')!, temp = cliSettings.find(s => s.key === 'temp-dir')!, auto = cliSettings.find(s => s.key === 'auto-integrate')!;
  assert.deepEqual(normalize(target, ['vscode', 'claude']), normalize(target, 'vscode, claude'));
  assert.deepEqual(pushArguments(target, ['vscode', 'claude']), ['config', 'set', 'target', 'vscode,claude']);
  assert.deepEqual(pushArguments(target, []), ['config', 'unset', 'target']);
  assert.deepEqual(pushArguments(temp, ''), ['config', 'unset', 'temp-dir']);
  assert.deepEqual(pushArguments(auto, true), ['config', 'set', 'auto-integrate', 'true']);
  assert.equal(normalize(auto, undefined), true);
  assert.throws(() => normalize(auto, 'false'), /must be a boolean/);
  assert.throws(() => normalize(target, ['vscode', 5]), /only strings/);
  assert.equal(settingValue(auto, true), undefined);
  assert.equal(settingValue(auto, false), false);
});

test('CLI configuration sync pushes setting edits and pulls CLI edits', () => {
  assert.equal(direction(true, true, undefined), 'none');
  assert.equal(direction(false, true, undefined), 'pull');
  assert.equal(direction(false, true, undefined, true), 'push');
  assert.equal(direction(false, true, true), 'push');
  assert.equal(direction(true, false, true), 'pull');
});

test('webview protocol no longer accepts the removed marketplace page requests', () => {
  for (const type of ['previewSettings', 'applySettings', 'importSettings']) assert.throws(() => parseMessage({ type }));
  assert.throws(() => parseMessage({ type: 'removeMarketplace', name: 'x' }));
  assert.deepEqual(parseMessage({ type: 'marketplaces' }), { type: 'marketplaces' });
});
