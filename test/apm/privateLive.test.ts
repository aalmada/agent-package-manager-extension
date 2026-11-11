import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApmClient } from '../../src/apm/client';
import { cliEnvironment, type CliAuthentication } from '../../src/auth/cli';
import { repositoryFromPackageSource, repositoryProbeUrl } from '../../src/auth/repositories';

const executable = process.env.APM_TEST_EXECUTABLE;
const source = process.env.APM_PRIVATE_TEST_SOURCE;
const token = process.env.APM_PRIVATE_TEST_TOKEN;

test('real private direct package install rejects expired credentials and recovers', {
  skip: !source && !token, timeout: 180_000
}, async () => {
  assert.ok(executable, 'Set APM_TEST_EXECUTABLE to the APM CLI.');
  assert.ok(source && token, 'Set both APM_PRIVATE_TEST_SOURCE and APM_PRIVATE_TEST_TOKEN.');
  const repository = repositoryFromPackageSource(source);
  assert.ok(repository?.origin === 'https://github.com' && repository.provider === 'github',
    'The private live fixture must be a GitHub.com package source without credentials.');
  let currentToken = 'expired-test-token';
  const auth: CliAuthentication = {
    hosts: () => [],
    knownRepositories: () => [repository],
    credentials: async repositories => {
      assert.equal(repositories.length, 1);
      const response = await fetch(repositoryProbeUrl(repository), {
        headers: { Authorization: `Bearer ${currentToken}` }, redirect: 'error', signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error(`Private fixture access denied (HTTP ${response.status}).`);
      return [{ repository, token: currentToken, username: 'x-access-token', scheme: 'bearer' }];
    }
  };
  const home = await mkdtemp(join(tmpdir(), 'apm-private-direct-'));
  try {
    const project = join(home, 'project');
    await mkdir(project);
    const manifest = 'name: private-test\nversion: 1.0.0\ndependencies:\n  apm: []\n';
    await writeFile(join(project, 'apm.yml'), manifest);
    const client = new ApmClient({ executable, cwd: project, home,
      environment: (args, cwd, signal) => cliEnvironment(auth, args, cwd, home, signal) });
    await assert.rejects(client.execute(['install', source, '--target', 'copilot']), /Private fixture access denied/);
    assert.equal(await readFile(join(project, 'apm.yml'), 'utf8'), manifest);
    currentToken = token;
    const result = await client.execute(['install', source, '--target', 'copilot'], { timeoutMs: 120_000 });
    assert.equal(result.exitCode, 0, 'Private direct install failed; inspect the fixture and CLI authentication.');
    assert.ok((await readFile(join(project, 'apm.lock.yaml'), 'utf8')).length > 0);
    assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token), 'CLI output must redact the token.');
  } finally { await rm(home, { recursive: true, force: true }); }
});
