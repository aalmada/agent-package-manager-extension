import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { isSeq, parseDocument } from 'yaml';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { record } from '../../src/apm/adapters';
import { ApmClient } from '../../src/apm/client';
import { descriptors } from '../../src/apm/commands';
import { addArguments, matches, parseEntry } from '../../src/config/marketplaces';

const executable = process.env.APM_TEST_EXECUTABLE;
const git = promisify(execFile);
test('real initialization preserves every native answer in the selected project', { skip: !executable, timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'apm-init-native-'));
  try {
    const project = join(home, 'workspace'); await mkdir(project);
    const client = new ApmClient({ executable: executable!, cwd: project, home });
    const result = await client.execute(['init', '--target', 'copilot,claude', '.'], {
      inputLines: ['custom-name', '2.3.4', 'Native initialization: all fields', 'Example Author', 'y']
    });
    assert.equal(result.exitCode, 0, result.stdout + result.stderr);
    const manifest = parseDocument(await readFile(join(project, 'apm.yml'), 'utf8'));
    assert.equal(manifest.get('name'), 'custom-name');
    assert.equal(manifest.get('version'), '2.3.4');
    assert.equal(manifest.get('description'), 'Native initialization: all fields');
    assert.equal(manifest.get('author'), 'Example Author');
    const targets = manifest.get('targets', true);
    assert.ok(isSeq(targets));
    assert.deepEqual(targets.toJSON(), ['claude', 'copilot']);
    assert.ok(!(await readdir(project)).includes('custom-name'), 'Initialization must not create a nested project');
  } finally { await rm(home, { recursive: true }); }
});
test('real initialization accepts blank optional metadata and uses CLI defaults', { skip: !executable, timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'apm-init-optional-'));
  try {
    const project = join(home, 'workspace'); await mkdir(project);
    const client = new ApmClient({ executable: executable!, cwd: project, home });
    const result = await client.execute(['init', '.'], { inputLines: ['custom-name', '', '', '', 'y'] });
    assert.equal(result.exitCode, 0, result.stdout + result.stderr);
    const manifest = parseDocument(await readFile(join(project, 'apm.yml'), 'utf8'));
    assert.equal(manifest.get('name'), 'custom-name');
    assert.equal(manifest.get('version'), '1.0.0');
    assert.equal(typeof manifest.get('description'), 'string');
    assert.equal(typeof manifest.get('author'), 'string');
  } finally { await rm(home, { recursive: true }); }
});
test('real baseline update checks parse ASCII tables', { skip: !executable, timeout: 180_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'apm-outdated-test-'));
  try {
    await writeFile(join(home, 'apm.lock.yaml'), JSON.stringify({
      lockfile_version: '1', apm_version: '0.35.0', dependencies: [{
        repo_url: 'github/awesome-copilot', name: 'awesome-copilot', host: 'github.com',
        resolved_commit: '0000000000000000000000000000000000000000', resolved_ref: 'main', version: 'unknown'
      }]
    }));
    const output: string[] = [];
    const client = new ApmClient({ executable: executable!, cwd: home, home, onOutput: text => output.push(text) });
    const updates = await client.checkUpdates({ kind: 'workspace', path: home, label: 'project' }, []);
    assert.match(output.join(''), /^\|[-+]+\|$/m);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].package, 'github/awesome-copilot');
    assert.ok(['outdated', 'unknown'].includes(updates[0].status));
  } finally { await rm(home, { recursive: true }); }
});
test('real baseline CLI covers every descriptor and option', { skip: !executable, timeout: 180_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'apm-baseline-test-'));
  try {
    const project = join(home, 'project'); await mkdir(project);
    const client = new ApmClient({ executable: executable!, cwd: project, home });
    const probe = await client.probe();
    assert.equal(probe.version, '0.35.0');
    const helpCache = new Map<string, string>();
    for (const descriptor of descriptors) {
      const help = await client.execute([...descriptor.command, '--help']);
      assert.equal(help.exitCode, 0, descriptor.id + help.stderr);
      helpCache.set(descriptor.id, help.stdout);
      for (const option of descriptor.options) {
        const path = descriptor.command.slice(0, option.at ?? descriptor.command.length);
        const key = path.join(' ');
        let output = helpCache.get(key);
        if (!output) { output = (await client.execute([...path, '--help'])).stdout; helpCache.set(key, output); }
        if (option.hidden) {
          assert.ok(await client.supports(descriptor.command, [option.name]), `${descriptor.id}: hidden ${option.name}`);
        } else assert.ok(output.includes(option.name), `${descriptor.id}: missing ${option.name} at ${key}`);
      }
      const leafFlags = [...help.stdout.matchAll(/^\s{2}(--[\w-]+(?:\/--[\w-]+)?|-\w(?:,\s+--[\w-]+)?)/gm)].flatMap(match => match[0].match(/--[\w-]+/g) ?? []).filter(flag => flag !== '--help');
      const represented = new Set(descriptor.options.flatMap(o => [o.name, o.negative].filter(Boolean)));
      for (const flag of leafFlags) assert.ok(represented.has(flag), `${descriptor.id}: undocumented UI flag ${flag}`);
      for (const match of help.stdout.matchAll(/^\s{2}(?:-\w,\s+)?(--[\w-]+)\s+\[([^\]]+)\]/gm)) {
        const option = descriptor.options.find(o => o.name === match[1]);
        if (option?.optionalValue && !match[2].includes('|')) continue;
        assert.deepEqual(option?.choices, match[2].split('|'), `${descriptor.id}: missing or stale choices for ${match[1]}`);
      }
    }
    const paths = new Set(['']);
    for (const descriptor of descriptors) {
      for (let depth = 1; depth <= descriptor.command.length; depth++) paths.add(descriptor.command.slice(0, depth).join(' '));
    }
    for (const path of paths) {
      const output = helpCache.get(path) ?? (await client.execute([...(path ? path.split(' ') : []), '--help'])).stdout;
      let section = false;
      const names: string[] = [];
      for (const line of output.split('\n')) {
        if (/^(?:[\w -]+ )?commands:\s*$/i.test(line)) section = true;
        else if (/^\S/.test(line)) section = false;
        const match = section && /^ {2}([a-z][\w-]*)\s{2,}/.exec(line);
        if (match) names.push(match[1]);
      }
      if (!names.length) continue;
      for (const name of names) {
        const key = [path, name].filter(Boolean).join(' ');
        assert.ok(paths.has(key) || ['info', 'discover'].includes(key), `Public CLI command missing from visual contract: ${key}`);
      }
    }
  } finally { await rm(home, { recursive: true }); }
});
test('real baseline package workflows browse, install and read full metadata', { skip: !executable, timeout: 180_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'apm-workflow-test-'));
  try {
    const project = join(home, 'project'); await mkdir(project);
    const client = new ApmClient({ executable: executable!, cwd: project, home });
    const market = join(home, 'market'); await mkdir(market);
    await writeFile(join(market, 'marketplace.json'), JSON.stringify({
      name: 'local', owner: { name: 'Example' }, plugins: [
        { name: 'sample', source: './package', version: '1.0.0', description: 'Local sample' }
      ]
    }));
    const packagePath = join(market, 'package');
    await mkdir(join(packagePath, '.apm', 'skills', 'sample'), { recursive: true });
    await writeFile(join(packagePath, 'apm.yml'), 'name: sample\nversion: 1.0.0\ndescription: Local sample\nauthor: Example\nincludes: auto\ndependencies:\n  apm: []\n');
    await writeFile(join(packagePath, 'README.md'), '# Local sample\n\nPackage documentation.');
    await writeFile(join(packagePath, '.apm', 'skills', 'sample', 'SKILL.md'), '---\nname: sample\ndescription: Sample skill\n---\nReview the code.\n');
    const add = await client.execute(['marketplace', 'add', market, '--name', 'local']);
    assert.equal(add.exitCode, 0, add.stdout + add.stderr);
    const marketplaces = await client.getMarketplaces();
    assert.equal(marketplaces[0].name, 'local');
    const catalog = await client.getCatalog(marketplaces);
    assert.deepEqual(catalog.errors, []);
    assert.equal(catalog.items[0].name, 'sample');
    assert.equal(catalog.items[0].version, '1.0.0');
    const catalogDetails = await client.getDetails(catalog.items[0], { kind: 'workspace', path: project, label: 'project' });
    assert.equal(catalogDetails.identity, 'sample@local');
    assert.ok(Array.isArray(catalogDetails.contents) && catalogDetails.contents.some(group =>
      record(group) && group.kind === 'skills' && Array.isArray(group.items) &&
      group.items.some(item => record(item) && item.name === 'sample' && item.description === 'Sample skill')
    ), 'Catalog details list the package skill');
    assert.deepEqual(await client.getInstalled({ kind: 'workspace', path: project, label: 'project' }), []);
    const install = await client.execute(['install', packagePath, '--target', 'copilot']);
    assert.equal(install.exitCode, 0, install.stdout + install.stderr);
    const installed = await client.getInstalled({ kind: 'workspace', path: project, label: 'project' });
    assert.equal(installed.length, 1, JSON.stringify(installed));
    const details = await client.getDetails(installed[0], { kind: 'workspace', path: project, label: 'project' });
    assert.match(String(details.readme), /Package documentation/, JSON.stringify(Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'rawOutput'))));
    assert.ok(Array.isArray(details.contents) && details.contents.some(group =>
      record(group) && group.kind === 'skills' && Array.isArray(group.items) &&
      group.items.some(item => record(item) && item.name === 'sample')
    ), 'Installed details list the package skill');
    const updates = await client.checkUpdates({ kind: 'workspace', path: project, label: 'project' });
    assert.ok(updates.every(row => ['not-comparable', 'unknown', 'current', 'outdated'].includes(row.status)));
    const uninstall = await client.execute(['uninstall', String(installed[0].metadata?.cliIdentity)]);
    assert.equal(uninstall.exitCode, 0, uninstall.stdout + uninstall.stderr);
    assert.deepEqual(await client.getInstalled({ kind: 'workspace', path: project, label: 'project' }), []);
    const fromMarketplace = await client.execute(['install', 'sample@local', '--target', 'copilot']);
    assert.equal(fromMarketplace.exitCode, 0, fromMarketplace.stdout + fromMarketplace.stderr);
    const marketplaceInstalled = await client.getInstalled({ kind: 'workspace', path: project, label: 'project' });
    assert.equal(marketplaceInstalled[0].marketplace, 'local', JSON.stringify(marketplaceInstalled));
    assert.equal(marketplaceInstalled[0].id, 'local::sample');
  } finally { await rm(home, { recursive: true }); }
});

test('real baseline CLI registers a local Git marketplace at the requested ref', { skip: !executable, timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'apm-local-ref-test-'));
  try {
    const repository = join(home, 'repository'), templates = join(home, 'templates');
    await mkdir(repository); await mkdir(templates);
    const runGit = (...args: string[]) => git('git', ['-c', `init.templateDir=${templates}`, ...args], {
      cwd: repository,
      env: {
        ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'APM Test', GIT_AUTHOR_EMAIL: 'apm-test@example.invalid',
        GIT_COMMITTER_NAME: 'APM Test', GIT_COMMITTER_EMAIL: 'apm-test@example.invalid'
      }
    });
    await runGit('init', '-b', 'main');
    await writeFile(join(repository, 'marketplace.json'), JSON.stringify({ name: 'main-catalog', plugins: [] }));
    await runGit('add', 'marketplace.json'); await runGit('commit', '-m', 'main');
    await runGit('checkout', '-b', 'release');
    await writeFile(join(repository, 'marketplace.json'), JSON.stringify({ name: 'release-catalog', plugins: [] }));
    await runGit('add', 'marketplace.json'); await runGit('commit', '-m', 'release');
    await runGit('checkout', 'main');
    const entry = parseEntry(`${pathToFileURL(repository).href}#release`);
    const client = new ApmClient({ executable: executable!, cwd: home, home });
    const result = await client.execute(addArguments(entry));
    assert.equal(result.exitCode, 0, result.stdout + result.stderr);
    const [registered] = await client.getMarketplaces();
    assert.equal(registered.name, 'release-catalog');
    assert.equal(registered.ref, 'release');
    assert.ok(matches(entry, registered));
  } finally { await rm(home, { recursive: true }); }
});
