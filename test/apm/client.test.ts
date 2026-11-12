import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApmClient } from '../../src/apm/client';
import { record } from '../../src/apm/adapters';
import { redact } from '../../src/apm/redact';

test('process runner keeps exact arguments, separates streams and preserves exit codes', async () => {
  const client = new ApmClient({ executable: process.execPath, cwd: process.cwd() });
  const result = await client.execute(['-e', 'console.log(JSON.stringify(process.argv.slice(1))); console.error("diagnostic"); process.exitCode=3;', 'one value', ';echo nope']);
  assert.deepEqual(JSON.parse(result.stdout), ['one value', ';echo nope']); assert.match(result.stderr, /diagnostic/); assert.equal(result.exitCode, 3);
});
test('process runner surfaces startup errors, timeouts and cancellation', async () => {
  const client = new ApmClient({ executable: process.execPath, cwd: process.cwd() });
  await assert.rejects(client.execute(['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 40 }), /timed out/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.execute(['-e', ''], { signal: controller.signal }), /cancelled/);
  await assert.rejects(new ApmClient({ executable: '/missing-apm-executable', cwd: process.cwd() }).execute([]), /Could not start/);
});
test('streamed diagnostics are line-buffered so chunk boundaries cannot bypass redaction', async () => {
  const output: string[] = [];
  const client = new ApmClient({ executable: process.execPath, cwd: process.cwd(), onOutput: text => output.push(redact(text)) });
  await client.execute(['-e', 'process.stdout.write("Authorization: Bear");setTimeout(()=>process.stdout.write("er privatevalue\\n"),10)']);
  assert.ok(!output.join('').includes('privatevalue'));
});
test('process runner answers APM variable prompts through the prompt handler', async () => {
  const output: string[] = [];
  const client = new ApmClient({ executable: process.execPath, cwd: process.cwd(), onOutput: text => output.push(text) });
  const script = 'console.log("Environment variables needed:");process.stdout.write("  CONTEXT7_API_KEY (API key): ");' +
    'process.stdin.once("data",d=>{const value=String(d).trim();process.stdout.write("got="+value.slice(0,4));' +
    'console.error("diagnostic");setTimeout(()=>{console.log(value.slice(4));console.error("echo="+value);process.exit(0)},10)});process.stdin.once("end",()=>process.exit(5));';
  const asked: string[] = [];
  const answered = await client.execute(['-e', script], { onPrompt: async prompt => { asked.push(`${prompt.name}:${prompt.secret}`); return 'example-value'; } });
  assert.deepEqual(asked, ['CONTEXT7_API_KEY:true']);
  assert.match(answered.stdout, /got=\[redacted\]/);
  assert.match(answered.stderr, /echo=\[redacted\]/);
  assert.ok(!output.join('').includes('example-value'));
  assert.ok(!output.join('').includes('exam'));
  const skipped = await client.execute(['-e', script], { onPrompt: async () => undefined });
  assert.equal(skipped.exitCode, 5);
});
test('process runner refuses URL credentials without starting the executable', async () => {
  const client = new ApmClient({ executable: process.execPath, cwd: process.cwd() });
  await assert.rejects(client.execute(['https://example-user@host.test/repo']), /Do not put credentials in URLs/);
});
test('marketplace registry reads both current and legacy shapes without writing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apm-registry-test-'));
  try {
    const client = new ApmClient({ executable: process.execPath, cwd: home, home });
    assert.deepEqual(await client.getMarketplaces(), []);
    await mkdir(join(home, '.apm'));
    await writeFile(join(home, '.apm', 'marketplaces.json'), JSON.stringify({ marketplaces: [
      { name: 'legacy', owner: 'org', repo: 'repo', branch: 'stable' },
      { name: 'local', url: '/tmp/local market' },
      { name: 'remote', url: 'https://catalog.example/marketplace.json' }
    ] }));
    const rows = await client.getMarketplaces();
    assert.equal(rows[0].source, 'org/repo'); assert.equal(rows[1].source, '/tmp/local market');
    await writeFile(join(home, '.apm', 'marketplaces.json'), 'invalid');
    await assert.rejects(client.getMarketplaces(), /JSON/);
  } finally { await rm(home, { recursive: true }); }
});

test('catalog details use the plugin repository fetcher without requiring a globally authenticated CLI view', async t => {
  const home = await mkdtemp(join(tmpdir(), 'apm-private-details-'));
  try {
    await mkdir(join(home, '.apm', 'cache', 'marketplace'), { recursive: true });
    await writeFile(join(home, '.apm', 'marketplaces.json'), JSON.stringify({ marketplaces: [
      { name: 'catalog', owner: 'team', repo: 'catalog', url: 'https://github.com/team/catalog' }
    ] }));
    const plugin = { name: 'private-plugin', source: { source: 'github', repo: 'different/private', path: 'plugins/example', ref: 'release' } };
    await writeFile(join(home, '.apm', 'cache', 'marketplace', 'catalog.json'), JSON.stringify({ plugins: [plugin] }));
    const requests: string[] = [];
    const client = new ApmClient({ executable: '/must-not-start', cwd: home, home, fetcher: async input => {
      const url = new URL(String(input));
      requests.push(url.href);
      assert.match(url.pathname, /^\/repos\/different\/private\//);
      if (url.pathname.includes('/git/trees/')) return new Response(JSON.stringify({
        tree: [{ type: 'blob', path: 'plugins/example/skills/review/SKILL.md' }], truncated: false
      }));
      if (url.pathname.endsWith('/README.md')) return new Response('# Private plugin');
      if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: review\ndescription: Private review skill\n---\n');
      return new Response(null, { status: 404 });
    } });
    t.mock.method(client, 'execute', async () => assert.fail('Catalog metadata must not require CLI-wide account selection'));
    const details = await client.getDetails({ id: 'catalog::private-plugin', name: 'private-plugin', marketplace: 'catalog',
      installed: false, version: '1.0', metadata: { plugin } }, { kind: 'workspace', label: 'project', path: home });
    assert.equal(details.readme, '# Private plugin');
    assert.match(JSON.stringify(details.contents), /Private review skill/);
    assert.ok(requests.length >= 6);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('installed list recovers deployed standalone skills and opens their local details without a CLI view', async t => {
  const home = await mkdtemp(join(tmpdir(), 'apm-deployed-skill-test-'));
  try {
    const identity = 'anthropics/skills/skills/skill-creator';
    const path = '.agents/skills/skill-creator/SKILL.md';
    await mkdir(join(home, '.agents/skills/skill-creator'), { recursive: true });
    await writeFile(join(home, path), '---\nname: skill-creator\ndescription: Create and improve skills\n---\nSkill documentation.');
    await writeFile(join(home, 'apm.lock.yaml'), JSON.stringify({
      dependencies: [
        { repo_url: 'anthropics/skills', name: 'skills', host: 'github.com', version: 'unknown', virtual_path: 'skills/skill-creator',
          is_virtual: true, package_type: 'claude_skill', deployed_files: ['.agents/skills/skill-creator', path] },
        { repo_url: 'org/missing', package_type: 'claude_skill', deployed_files: ['.agents/skills/missing/SKILL.md'] },
        { repo_url: 'org/not-deployed', package_type: 'claude_skill' }
      ],
      deployments: [{ kind: 'project-relative', value: path, active_owner: identity }]
    }));
    await writeFile(join(home, 'apm.yml'), 'dependencies:\n  apm:\n  - org/manifest-only\n');
    const client = new ApmClient({ executable: process.execPath, cwd: home, home });
    const execute = t.mock.method(client, 'execute', async (args: string[]) => {
      assert.deepEqual(args, ['deps', 'list']);
      return { stdout: 'apm_modules/ directory exists but contains no valid packages (Project scope)', stderr: '', exitCode: 0 };
    });
    const scope = { kind: 'workspace' as const, path: home, label: 'project' };
    const items = await client.getInstalled(scope);
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'skill-creator');
    assert.equal(items[0].version, 'Not specified');
    assert.equal(items[0].installed, true);
    assert.equal(items[0].metadata?.cliIdentity, identity);
    assert.equal(items[0].metadata?.lockIdentity, identity);
    assert.equal(items[0].direct, true);
    assert.equal(items[0].updateStatus, 'unchecked');
    const details = await client.getDetails(items[0], scope);
    assert.ok(Array.isArray(details.contents) && details.contents.some(group =>
      record(group) && group.kind === 'skills' && Array.isArray(group.items) &&
      group.items.some(item => record(item) && item.name === 'skill-creator' && item.description === 'Create and improve skills')
    ));
    assert.ok(Array.isArray(details.contentsNotes) && details.contentsNotes.some(note => /deployed skill/.test(String(note))));
    assert.equal(execute.mock.callCount(), 1);
    execute.mock.mockImplementation(async (args: string[]) => {
      assert.deepEqual(args, ['outdated']);
      return { stdout: `| Package | Current | Latest | Status | Source |\n| ${identity} | unknown | - | unknown | github |`, stderr: '', exitCode: 0 };
    });
    const updates = await client.checkUpdates(scope, items);
    assert.equal(updates[0].package, items[0].metadata?.lockIdentity);
    assert.equal(updates[0].status, 'unknown');
  } finally { await rm(home, { recursive: true }); }
});

test('deployed-skill recovery preserves aliases, hosts and marketplaces without duplicating CLI-listed packages', async t => {
  const home = await mkdtemp(join(tmpdir(), 'apm-deployed-skill-test-'));
  try {
    const identity = 'git.example.com/org/repo/skills/sample', path = '.github/skills/sample/SKILL.md';
    await mkdir(join(home, '.github/skills/sample'), { recursive: true });
    await writeFile(join(home, path), '# Sample');
    const dep = {
      repo_url: 'org/repo', host: 'git.example.com', alias: 'sample-alias', virtual_path: 'skills/sample',
      is_virtual: true, package_type: 'claude_skill', version: '1.2.3', depth: 2, deployed_files: [path]
    };
    const lockfile = join(home, 'apm.lock.yaml');
    await writeFile(lockfile, JSON.stringify({ dependencies: [dep] }));
    const client = new ApmClient({ executable: process.execPath, cwd: home, home });
    const execute = t.mock.method(client, 'execute', async () => ({ stdout: 'No dependencies installed.', stderr: '', exitCode: 0 }));
    const scope = { kind: 'workspace' as const, path: home, label: 'project' };
    const direct = await client.getInstalled(scope);
    assert.equal(direct.length, 1);
    assert.equal(direct[0].id, 'installed::sample-alias');
    assert.equal(direct[0].metadata?.cliIdentity, 'sample-alias');
    assert.equal(direct[0].metadata?.lockIdentity, identity);
    await writeFile(lockfile, JSON.stringify({ dependencies: [{ ...dep, discovered_via: 'test', marketplace_plugin_name: 'sample' }] }));
    const recovered = await client.getInstalled(scope);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, 'test::sample');
    assert.equal(recovered[0].version, '1.2.3');
    assert.equal(recovered[0].direct, false);
    assert.equal(recovered[0].metadata?.installExpression, 'sample@test');
    execute.mock.mockImplementation(async () => ({
      stdout: '| Package | Version | Source |\n| sample-alias | 1.2.3 | github |', stderr: '', exitCode: 0
    }));
    const listed = await client.getInstalled(scope);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, recovered[0].id);
    assert.equal(listed[0].metadata?.deployedSkillPath, undefined);
  } finally { await rm(home, { recursive: true }); }
});

test('deployed-skill recovery excludes inactive owners and rejects escaping paths and symlinks', async t => {
  const home = await mkdtemp(join(tmpdir(), 'apm-deployed-skill-test-'));
  try {
    const project = join(home, 'project'), path = '.agents/skills/sample/SKILL.md';
    await mkdir(join(project, '.agents/skills/sample'), { recursive: true });
    await writeFile(join(project, path), '# Sample');
    const dep = { repo_url: 'org/repo', package_type: 'claude_skill', deployed_files: [path] };
    const lockfile = join(project, 'apm.lock.yaml');
    await writeFile(lockfile, JSON.stringify({
      dependencies: [dep], deployments: [{ kind: 'project-relative', value: path, active_owner: 'other/repo' }]
    }));
    const client = new ApmClient({ executable: process.execPath, cwd: project, home });
    t.mock.method(client, 'execute', async () => ({ stdout: 'No dependencies installed.', stderr: '', exitCode: 0 }));
    const scope = { kind: 'workspace' as const, path: project, label: 'project' };
    assert.deepEqual(await client.getInstalled(scope), []);
    await writeFile(lockfile, JSON.stringify({ dependencies: [{ ...dep, deployed_files: ['../outside/SKILL.md'] }] }));
    await assert.rejects(client.getInstalled(scope), /escapes/);
    await mkdir(join(home, 'outside'));
    await writeFile(join(home, 'outside/SKILL.md'), '# Outside');
    await symlink(join(home, 'outside'), join(project, 'linked'), 'dir');
    await writeFile(lockfile, JSON.stringify({ dependencies: [{ ...dep, deployed_files: ['linked/SKILL.md'] }] }));
    await assert.rejects(client.getInstalled(scope), /symlink escapes/);
  } finally { await rm(home, { recursive: true }); }
});

test('installed list recovers four deployed private bundles without authentication or stale plugin duplicates', async t => {
  const home = await mkdtemp(join(tmpdir(), 'apm-deployed-bundles-test-'));
  try {
    const names = ['development', 'analysis', 'automation', 'integration'];
    const dependencies = names.map(name => ({
      repo_url: 'team/private', name, virtual_path: `plugins/${name}`, is_virtual: true,
      package_type: 'skill_bundle', version: '1.2.3', discovered_via: 'catalog', marketplace_plugin_name: name,
      deployed_files: [`.agents/skills/${name}/SKILL.md`, `.github/agents/${name}.agent.md`]
    }));
    for (const dep of dependencies) {
      for (const path of dep.deployed_files) {
        await mkdir(join(home, path, '..'), { recursive: true });
        await writeFile(join(home, path), `---\nname: ${dep.name}\ndescription: ${dep.name} description\n---\n`);
      }
    }
    const reference = '.agents/skills/development/references/old.md';
    await mkdir(join(home, reference, '..'), { recursive: true });
    await writeFile(join(home, reference), '# Old reference');
    await mkdir(join(home, '.agents/skills/unrelated'), { recursive: true });
    await writeFile(join(home, '.agents/skills/unrelated/SKILL.md'), '# Unrelated');
    const deployments = dependencies.flatMap(dep => dep.deployed_files.map(value => ({
      kind: 'project-relative', value, active_owner: `${dep.repo_url}/${dep.virtual_path}`
    })));
    await writeFile(join(home, 'apm.yml'), 'dependencies:\n  apm:\n  - team/private/plugins/not-installed\n');
    await writeFile(join(home, 'apm.lock.yaml'), JSON.stringify({
      dependencies: [
        { repo_url: '_local/development', name: 'development', source: 'local', local_path: '/old/development',
          package_type: 'marketplace_plugin', deployed_files: [...dependencies[0].deployed_files, reference] },
        ...dependencies,
        { repo_url: 'team/missing', package_type: 'skill_bundle', deployed_files: ['.agents/skills/missing/SKILL.md'] }
      ], deployments
    }));
    const client = new ApmClient({ executable: '/must-not-start', cwd: home, home,
      fetcher: async () => assert.fail('Deployed contents must not require private repository access'),
      environment: async () => assert.fail('Local discovery must not request credentials') });
    const execute = t.mock.method(client, 'execute', async (args: string[]) => {
      assert.deepEqual(args, ['deps', 'list']);
      return { stdout: 'No APM dependencies installed (Project scope)', stderr: '', exitCode: 0 };
    });
    const scope = { kind: 'workspace' as const, path: home, label: 'project' };
    const items = await client.getInstalled(scope);
    assert.deepEqual(items.map(item => item.name), names);
    for (const item of items) {
      assert.equal(item.id, `catalog::${item.name}`);
      assert.equal(item.version, '1.2.3');
      assert.equal(item.metadata?.cliIdentity, `team/private/plugins/${item.name}`);
      assert.equal(item.metadata?.installExpression, `${item.name}@catalog`);
      const details = await client.getDetails(item, scope);
      assert.deepEqual(details.contents, [
        { kind: 'skills', items: [{ name: item.name, path: `.agents/skills/${item.name}/SKILL.md`, description: `${item.name} description` }] },
        { kind: 'agents', items: [{ name: item.name, path: `.github/agents/${item.name}.agent.md`, description: `${item.name} description` }] }
      ]);
      assert.equal(details.localContentRoot, home);
      assert.match(JSON.stringify(details.contentsNotes), /verified deployed contents/);
    }
    assert.equal(execute.mock.callCount(), 1);
    execute.mock.mockImplementation(async () => ({
      stdout: '| Package | Version | Source |\n' + dependencies.map(dep =>
        `| ${dep.repo_url}/${dep.virtual_path} | 1.2.3 | github |`).join('\n'), stderr: '', exitCode: 0
    }));
    const listed = await client.getInstalled(scope);
    assert.equal(listed.length, 4);
    assert.ok(listed.every(item => item.metadata?.deployedPackagePaths === undefined));
  } finally { await rm(home, { recursive: true }); }
});

test('deployed plugin recovery supports global agent-only packages and rejects escaping symlinks', async t => {
  const home = await mkdtemp(join(tmpdir(), 'apm-deployed-plugin-test-'));
  try {
    const root = join(home, '.apm'), path = '.github/agents/review.agent.md';
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), '# Review');
    const lock = { dependencies: [{
      repo_url: 'team/review', name: 'review', alias: 'review-alias', package_type: 'marketplace_plugin', deployed_files: [path]
    }] };
    await writeFile(join(root, 'apm.lock.yaml'), JSON.stringify(lock));
    const client = new ApmClient({ executable: '/must-not-start', cwd: home, home });
    t.mock.method(client, 'execute', async (args: string[], options: { cwd?: string }) => {
      assert.deepEqual(args, ['deps', 'list', '--global']);
      assert.equal(options.cwd, home);
      return { stdout: 'No dependencies installed.', stderr: '', exitCode: 0 };
    });
    const scope = { kind: 'global' as const, path: root, label: 'Global' };
    const items = await client.getInstalled(scope);
    assert.equal(items.length, 1);
    assert.equal(items[0].metadata?.cliIdentity, 'review-alias');
    assert.equal(items[0].metadata?.lockIdentity, 'team/review');
    const details = await client.getDetails(items[0], scope);
    assert.deepEqual(details.contents, [{ kind: 'agents', items: [{ name: 'review', path }] }]);
    await writeFile(join(home, 'outside.agent.md'), '# Outside');
    await symlink(join(home, 'outside.agent.md'), join(root, '.github/agents/outside.agent.md'));
    lock.dependencies[0].deployed_files = ['.github/agents/outside.agent.md'];
    await writeFile(join(root, 'apm.lock.yaml'), JSON.stringify(lock));
    await assert.rejects(client.getInstalled(scope), /symlink escapes/);
  } finally { await rm(home, { recursive: true }); }
});
