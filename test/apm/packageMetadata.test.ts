import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { declaredContents, mergeContents, repositoryComposition } from '../../src/apm/contents';
import { inspectBarePackage, inspectLocalPackage, inspectRemotePackage, remoteSource } from '../../src/apm/packageMetadata';
import { execFileSync } from 'node:child_process';

test('declared component paths and named maps become grouped contents', () => {
  const declared = declaredContents({
    skills: ['./skills/review/'],
    agents: [{ name: 'Planner', path: './agents/plan.agent.md', description: 'Plans.' }],
    mcpServers: { search: { command: 'server' } }
  });
  const merged = mergeContents(declared, [{
    kind: 'skills', items: [{ name: 'review', path: 'skills/review/SKILL.md', description: 'Review changes.' }]
  }]);
  assert.deepEqual(merged.map(group => group.kind), ['skills', 'agents', 'mcpServers']);
  assert.equal(merged[0].items.length, 1);
  assert.equal(merged[0].items[0].description, 'Review changes.');
  assert.equal(merged[1].items[0].name, 'Planner');
  assert.equal(merged[2].items[0].name, 'search');
});

test('local packages expose real skills, agents and prompts without following escaping symlinks', async () => {
  const home = await mkdtemp(join(process.cwd(), '.test-package-metadata-'));
  try {
    const root = join(home, 'package');
    await mkdir(join(root, '.github', 'plugin'), { recursive: true });
    await mkdir(join(root, '.apm', 'skills', 'review'), { recursive: true });
    await mkdir(join(root, '.github', 'agents'), { recursive: true });
    await mkdir(join(root, '.apm', 'prompts'), { recursive: true });
    await writeFile(join(root, '.github', 'plugin', 'plugin.json'), JSON.stringify({ name: 'example', skills: ['./.apm/skills/review/'] }));
    await writeFile(join(root, 'apm.yml'), 'name: example\nversion: 1.0.0\nkeywords: [quality]\n');
    await writeFile(join(root, 'README.md'), '# Example');
    await writeFile(join(root, '.apm', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review changes. USE FOR: pull requests;\n  large diffs.\n---\nInstructions.');
    await writeFile(join(root, '.github', 'agents', 'plan.agent.md'), '---\nname: Planner\ndescription: Plan the work.\n---\nInstructions.');
    await writeFile(join(root, '.apm', 'prompts', 'summarize.prompt.md'), 'Summarize changes.');
    if (process.platform !== 'win32') {
      await mkdir(join(home, 'outside'));
      await writeFile(join(home, 'outside', 'SKILL.md'), '---\nname: private-outside\n---\n');
      await symlink(join(home, 'outside'), join(root, '.apm', 'skills', 'escape'));
    }
    const details = await inspectLocalPackage(home, 'package');
    assert.equal(details.pluginManifest?.name, 'example');
    assert.equal(details.manifest?.version, '1.0.0');
    assert.equal(details.readme, '# Example');
    const skills = details.contents.find(group => group.kind === 'skills')?.items ?? [];
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'review');
    assert.equal(skills[0].description, 'Review changes. USE FOR: pull requests; large diffs.');
    assert.doesNotMatch(details.notices.join('\n'), /Could not read the description/);
    assert.equal(details.contents.find(group => group.kind === 'agents')?.items[0].name, 'Planner');
    assert.equal(details.contents.find(group => group.kind === 'prompts')?.items[0].name, 'summarize');
    if (process.platform !== 'win32') {
      assert.match(details.notices.join('\n'), /symlink escapes/);
      assert.ok(!JSON.stringify(details).includes('private-outside'));
    }
    await assert.rejects(inspectLocalPackage(home, '../outside'), /escapes/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('GitHub package metadata includes declared and discovered contents at the pinned commit', async () => {
  const source = remoteSource({
    source: 'github', repo: 'microsoft/azure-dev-tools', path: 'canvases/azure-cost-health-check',
    sha: '40f89b5b3f0f01e9262cfec3ad361cf4ebb22905'
  }, { name: 'awesome-copilot', source: 'https://github.com/github/awesome-copilot', host: 'github.com' });
  assert.ok(source);
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push(url.toString());
    const path = url.pathname;
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    if (path.includes('/git/trees/')) return new Response(JSON.stringify({
      truncated: false, tree: [
        { type: 'blob', path: 'canvases/azure-cost-health-check/skills/azure-cost-health-check/SKILL.md' },
        { type: 'blob', path: 'canvases/azure-cost-health-check/.github/agents/review.agent.md' },
        { type: 'blob', path: 'another-plugin/skills/secret/SKILL.md' }
      ]
    }), { status: 200 });
    assert.equal(new Headers(init?.headers).get('accept'), 'application/vnd.github.raw+json');
    if (path.endsWith('/.github/plugin/plugin.json')) return new Response(JSON.stringify({
      name: 'azure-cost-health-check', skills: ['./skills/azure-cost-health-check/']
    }), { status: 200 });
    if (path.endsWith('/README.md')) return new Response('# Read me', { status: 200 });
    if (path.endsWith('/skills/azure-cost-health-check/SKILL.md')) return new Response(
      '---\nname: azure-cost-health-check\ndescription: Check cloud spend and forecasts.\n---\nSkill body is not needed here.', { status: 200 }
    );
    if (path.endsWith('/.github/agents/review.agent.md')) return new Response(
      '---\nname: reviewer\ndescription: Review changes for correctness.\n---\nAgent body is not needed here.', { status: 200 }
    );
    return new Response(null, { status: 404 });
  };
  const details = await inspectRemotePackage(source, fakeFetch);
  assert.equal(requests.length, 8);
  assert.ok(requests.every(url => url.includes('40f89b5b3f0f01e9262cfec3ad361cf4ebb22905')));
  assert.equal(details.pluginManifest?.name, 'azure-cost-health-check');
  assert.equal(details.readme, '# Read me');
  assert.deepEqual(details.contents.map(group => [group.kind, group.items.map(item => item.name)]), [
    ['skills', ['azure-cost-health-check']], ['agents', ['reviewer']]
  ]);
  assert.equal(details.contents[0].items[0].description, 'Check cloud spend and forecasts.');
  assert.equal(details.contents[1].items[0].description, 'Review changes for correctness.');
  assert.deepEqual(details.notices, []);
});

test('unavailable or unsafe GitHub metadata is explicit and never sent to another host', async () => {
  const marketplace = { name: 'example', source: 'https://github.com/example/repo', host: 'github.com' };
  assert.throws(() => remoteSource({ source: 'github', repo: 'example/repo', path: '../secret' }, marketplace), /unsafe/);
  assert.equal(remoteSource({ source: 'git', url: 'https://private.example.com/example/repo' }, marketplace), undefined);
  const source = remoteSource({ source: 'github', repo: 'example/repo', ref: 'branch/name' }, marketplace);
  assert.ok(source);
  const fakeFetch: typeof fetch = async input => {
    assert.match(String(input), /^https:\/\/api\.github\.com\//);
    assert.match(String(input), /branch%2Fname/);
    return new Response(null, { status: 403 });
  };
  const details = await inspectRemotePackage(source, fakeFetch);
  assert.deepEqual(details.contents, []);
  assert.match(details.notices.join('\n'), /HTTP 403/);
});

const awesomeManifest = {
  name: 'cockpit',
  extensions: {
    'com.github.copilot': { logo: 'assets/preview.png' },
    'com.github.awesome-copilot': {
      skills: ['./skills/assess/', './skills/missing/', '../escape/'],
      agents: ['./agents/reporter.md'],
      extensions: ['./extensions/board']
    }
  }
};

test('awesome-copilot composition maps plugin-relative entries to repository-root sources', () => {
  assert.deepEqual(repositoryComposition(awesomeManifest).map(group => [group.kind, group.items.map(item => [item.name, item.path])]), [
    ['skills', [['assess', 'skills/assess'], ['missing', 'skills/missing']]],
    ['agents', [['reporter', 'agents/reporter.agent.md']]],
    ['extensions', [['board', 'extensions/board']]]
  ]);
  assert.deepEqual(repositoryComposition({ skills: ['./skills/top-level/'], extensions: { other: { skills: ['./skills/x/'] } } }), []);
  assert.deepEqual(declaredContents(awesomeManifest), []);
});

test('GitHub source manifests resolve awesome-copilot contents from the repository root with descriptions', async () => {
  const source = remoteSource('plugins/cockpit', { name: 'awesome-copilot', source: 'github/awesome-copilot', host: 'github.com' });
  assert.ok(source);
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async input => {
    const url = new URL(String(input)); requests.push(url.toString());
    const path = url.pathname;
    if (path.includes('/git/trees/')) return new Response(JSON.stringify({
      truncated: false, tree: [
        { type: 'blob', path: 'plugins/cockpit/plugin.json' },
        { type: 'blob', path: 'skills/assess/SKILL.md' },
        { type: 'blob', path: 'agents/reporter.agent.md' },
        { type: 'blob', path: 'extensions/board/extension.mjs' },
        { type: 'blob', path: 'extensions/board/package.json' },
        { type: 'blob', path: 'extensions/cockpit/extension.mjs' }
      ]
    }), { status: 200 });
    assert.equal(url.searchParams.get('ref'), 'HEAD');
    if (path.endsWith('/contents/plugins/cockpit/plugin.json')) return new Response(JSON.stringify(awesomeManifest), { status: 200 });
    if (path.endsWith('/contents/skills/assess/SKILL.md')) return new Response('---\ndescription: Assess readiness.\n---\nBody', { status: 200 });
    if (path.endsWith('/contents/agents/reporter.agent.md')) return new Response('---\nname: AI Reporter\ndescription: Writes the report.\n---\n', { status: 200 });
    if (path.endsWith('/contents/extensions/board/package.json')) return new Response(JSON.stringify({ name: 'pkg', description: 'Kanban board.' }), { status: 200 });
    return new Response(null, { status: 404 });
  };
  const details = await inspectRemotePackage(source, fakeFetch);
  assert.deepEqual(details.contents.map(group => [group.kind, group.items.map(item => [item.name, item.description])]), [
    ['skills', [['assess', 'Assess readiness.']]],
    ['agents', [['AI Reporter', 'Writes the report.']]],
    ['extensions', [['board', 'Kanban board.'], ['cockpit', undefined]]]
  ]);
  assert.match(details.notices.join('\n'), /1 declared content was not found/);
  assert.equal(details.notes?.length, 1);
  assert.ok(!requests.some(url => url.includes('/missing/') || url.includes('escape')));
});

test('published plugin folders expose com.github.copilot agents and extensions without a composition note', async () => {
  const source = remoteSource('plugins/cockpit', { name: 'awesome-copilot', source: 'github/awesome-copilot', host: 'github.com', ref: 'marketplace' });
  assert.ok(source);
  const fakeFetch: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.includes('/git/trees/')) return new Response(JSON.stringify({
      truncated: false, tree: [
        { type: 'blob', path: 'plugins/cockpit/skills/assess/SKILL.md' },
        { type: 'blob', path: 'plugins/cockpit/com.github.copilot/agents/reporter.md' },
        { type: 'blob', path: 'plugins/cockpit/com.github.copilot/extensions/board/extension.mjs' },
        { type: 'blob', path: 'plugins/cockpit/com.github.copilot/extensions/board/public/index.html' }
      ]
    }), { status: 200 });
    if (path.endsWith('/com.github.copilot/extensions/board/package.json')) return new Response('{"description":"Board UI."}', { status: 200 });
    return new Response(null, { status: 404 });
  };
  const details = await inspectRemotePackage(source, fakeFetch);
  assert.deepEqual(details.contents.map(group => [group.kind, group.items.map(item => item.name)]), [
    ['skills', ['assess']], ['agents', ['reporter']], ['extensions', ['board']]
  ]);
  assert.equal(details.contents[2].items[0].description, 'Board UI.');
  assert.deepEqual(details.notes, []);
});

test('local marketplace clones resolve composition from the repository; installed copies list names only', async () => {
  const home = await mkdtemp(join(process.cwd(), '.test-composition-'));
  try {
    await mkdir(join(home, 'plugins', 'cockpit'), { recursive: true });
    await mkdir(join(home, 'skills', 'assess'), { recursive: true });
    await mkdir(join(home, 'agents'), { recursive: true });
    await mkdir(join(home, 'extensions', 'board'), { recursive: true });
    await writeFile(join(home, 'plugins', 'cockpit', 'plugin.json'), JSON.stringify(awesomeManifest));
    await writeFile(join(home, 'skills', 'assess', 'SKILL.md'), '---\ndescription: Assess readiness.\n---\n');
    await writeFile(join(home, 'agents', 'reporter.agent.md'), '---\ndescription: Writes the report.\n---\n');
    await writeFile(join(home, 'extensions', 'board', 'extension.mjs'), '');
    await writeFile(join(home, 'extensions', 'board', 'package.json'), '{"description":"Kanban board."}');
    const clone = await inspectLocalPackage(home, 'plugins/cockpit', { repositoryRoot: true });
    assert.deepEqual(clone.contents.map(group => [group.kind, group.items.map(item => item.description)]), [
      ['skills', ['Assess readiness.']], ['agents', ['Writes the report.']], ['extensions', ['Kanban board.']]
    ]);
    assert.equal(clone.notes?.length, 1);
    const installed = await inspectLocalPackage(home, 'plugins/cockpit');
    assert.deepEqual(installed.contents.map(group => [group.kind, group.items.map(item => [item.name, item.description])]), [
      ['skills', [['assess', undefined], ['missing', undefined]]], ['agents', [['reporter', undefined]]], ['extensions', [['board', undefined]]]
    ]);
    assert.equal(installed.notes?.length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('bare marketplace caches resolve awesome-copilot composition with git', async () => {
  const home = await mkdtemp(join(process.cwd(), '.test-bare-composition-'));
  try {
    const work = join(home, 'work');
    await mkdir(join(work, 'plugins', 'cockpit'), { recursive: true });
    await mkdir(join(work, 'skills', 'assess'), { recursive: true });
    await writeFile(join(work, 'plugins', 'cockpit', 'plugin.json'), JSON.stringify(awesomeManifest));
    await writeFile(join(work, 'skills', 'assess', 'SKILL.md'), '---\ndescription: Assess readiness.\n---\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: work, stdio: 'pipe' });
    git('init', '-q', '-b', 'main'); git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
    execFileSync('git', ['clone', '-q', '--bare', work, join(home, 'cache.git')]);
    const details = await inspectBarePackage(join(home, 'cache.git'), 'main', 'plugins/cockpit');
    assert.deepEqual(details.contents.map(group => [group.kind, group.items.map(item => [item.name, item.description])]), [
      ['skills', [['assess', 'Assess readiness.']]]
    ]);
    assert.match(details.notices.join('\n'), /3 declared contents were not found/);
    assert.equal(details.notes?.length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});
