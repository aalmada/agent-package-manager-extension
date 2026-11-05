import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApmClient } from '../../src/apm/client';

test('older CLI offers only probed capabilities and reports its compatibility boundary', { skip: !process.env.APM_LEGACY_EXECUTABLE }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'apm-legacy-test-'));
  try {
    const client = new ApmClient({ executable: process.env.APM_LEGACY_EXECUTABLE!, cwd: home, home });
    const probe = await client.probe();
    assert.equal(probe.version, '0.28.0'); assert.match(probe.warning ?? '', /APM 0\.28\.0 is out of date\. Update to APM 0\.35\.0/);
    assert.ok(await client.supports(['marketplace', 'add'], ['--ref']));
    assert.equal(await client.supports(['auth']), false);
    assert.equal(await client.supports(['install'], ['--definitely-unsupported']), false);
  } finally { await rm(home, { recursive: true }); }
});

test('older CLI omits uncached standalone skills but the installed list reads their verified deployments', { skip: !process.env.APM_LEGACY_EXECUTABLE }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'apm-legacy-deployed-test-'));
  try {
    const path = '.agents/skills/skill-creator/SKILL.md';
    await mkdir(join(home, '.agents/skills/skill-creator'), { recursive: true });
    await mkdir(join(home, 'apm_modules'));
    await writeFile(join(home, path), '---\nname: skill-creator\ndescription: Create skills\n---\nInstructions.');
    await writeFile(join(home, 'apm.yml'), 'name: test\nversion: 1.0.0\ndependencies:\n  apm:\n  - anthropics/skills/skills/skill-creator\n');
    await writeFile(join(home, 'apm.lock.yaml'), JSON.stringify({ dependencies: [{
      repo_url: 'anthropics/skills', name: 'skills', host: 'github.com', version: 'unknown',
      is_virtual: true, virtual_path: 'skills/skill-creator', package_type: 'claude_skill', deployed_files: [path]
    }] }));
    const client = new ApmClient({ executable: process.env.APM_LEGACY_EXECUTABLE!, cwd: home, home });
    const output = await client.execute(['deps', 'list']);
    assert.equal(output.exitCode, 0, output.stderr);
    assert.match(output.stdout, /contains no valid packages/);
    const scope = { kind: 'workspace' as const, path: home, label: 'project' };
    const items = await client.getInstalled(scope);
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'skill-creator');
    const details = await client.getDetails(items[0], scope);
    assert.ok(Array.isArray(details.contents) && details.contents.length > 0);
  } finally { await rm(home, { recursive: true }); }
});
