import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cliEnvironment, type CliAuthentication, type CliCredential } from '../../src/auth/cli';
import type { Repository } from '../../src/auth/repositories';
import { ApmClient } from '../../src/apm/client';

const repository = (path: string, origin = 'https://github.com', provider: Repository['provider'] = 'github'): Repository =>
  ({ path, origin, provider });

function authentication(entries: readonly CliCredential[] = [], bindings = entries.map(entry => entry.repository)) {
  const calls: Repository[][] = [];
  const auth: CliAuthentication = {
    hosts: () => [{ origin: 'https://git.example.test', provider: 'gitlab' }],
    knownRepositories: () => bindings,
    credentials: async repositories => {
      calls.push([...repositories]);
      return entries.filter(entry => repositories.some(repository => repository.origin === entry.repository.origin &&
        repository.path === entry.repository.path));
    }
  };
  return { auth, calls };
}
const credential = (path: string, token: string): CliCredential =>
  ({ repository: repository(path), token, scheme: 'basic', username: 'token' });

async function fixture(operation: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'apm-cli-auth-'));
  try {
    await mkdir(join(home, '.apm'));
    await writeFile(join(home, '.apm', 'marketplaces.json'), JSON.stringify({ marketplaces: [
      { name: 'first', owner: 'team', repo: 'repo-a' },
      { name: 'second', owner: 'team', repo: 'repo-b' }
    ] }));
    await operation(home);
  } finally { await rm(home, { recursive: true, force: true }); }
}

test('help, local tasks and scripts never enumerate or inject repository credentials', async () => {
  const { auth, calls } = authentication([credential('team/repo-a', 'opaque-private-value')]);
  for (const args of [['--version'], ['install', '--help'], ['compile', '--watch'], ['deps', 'list'], ['run', 'script'],
    ['view', 'installed-package'], ['config', 'set', 'target', 'copilot'], ['marketplace', 'list']]) {
    assert.deepEqual(await cliEnvironment(auth, args, '/missing', '/missing'), {});
  }
  assert.equal(calls.length, 0);
});

test('separate marketplace refreshes select different credentials for the same organization', async () => {
  await fixture(async home => {
    const { auth } = authentication([credential('team/repo-a', 'first-opaque-value'), credential('team/repo-b', 'second-opaque-value')]);
    assert.deepEqual(await cliEnvironment(auth, ['marketplace', 'update', 'first'], home, home),
      { GITHUB_APM_PAT: 'first-opaque-value' });
    assert.deepEqual(await cliEnvironment(auth, ['marketplace', 'update', 'second'], home, home),
      { GITHUB_APM_PAT: 'second-opaque-value' });
    await assert.rejects(cliEnvironment(auth, ['marketplace', 'update'], home, home), /cannot safely route/);
  });
});

test('new marketplace registration preflights its concrete repository, not every saved account', async () => {
  await fixture(async home => {
    const { auth, calls } = authentication([credential('team/repo-b', 'second-opaque-value')]);
    assert.deepEqual(await cliEnvironment(auth, ['marketplace', 'add', 'https://github.com/team/repo-b.git', '--name', 'another'], home, home),
      { GITHUB_APM_PAT: 'second-opaque-value' });
    assert.deepEqual(calls, [[repository('team/repo-b')]]);
  });
});

test('direct GitHub subdirectory installs select the repository credential and preserve safety gates', async () => {
  await fixture(async home => {
    const { auth, calls } = authentication([credential('team/repo-a', 'first-opaque-value')]);
    assert.deepEqual(await cliEnvironment(auth, ['install', 'team/repo-a/plugins/example#main'], home, home),
      { GITHUB_APM_PAT: 'first-opaque-value' });
    assert.deepEqual(calls[0], [repository('team/repo-a')]);
    const conflicting = authentication([credential('team/repo-a', 'one'), credential('team/repo-b', 'two')]);
    await assert.rejects(cliEnvironment(conflicting.auth, ['install', 'team/repo-a/plugins/example', 'team/repo-b/skills/demo'], home, home),
      error => /Different credentials/.test(String(error)) && /team\/repo-a/.test(String(error)) && /team\/repo-b/.test(String(error)));
    const unrelated = authentication([credential('team/repo-a', 'one')], [repository('team/repo-a'), repository('team/repo-b')]);
    await assert.rejects(cliEnvironment(unrelated.auth, ['install', 'team/repo-a/plugins/example'], home, home),
      /Saved bindings outside this operation: https:\/\/github.com\/team\/repo-b/);
  });
});

test('scoped marketplace operations use raw provider tokens with the CLI-specific environment name', async () => {
  await fixture(async home => {
    const cases: { repository: Repository; scheme: CliCredential['scheme']; variable: string }[] = [
      { repository: repository('team/repo-a'), scheme: 'bearer', variable: 'GITHUB_APM_PAT' },
      { repository: repository('team/repo-a', 'https://gitlab.com', 'gitlab'), scheme: 'basic', variable: 'GITLAB_APM_PAT' },
      { repository: repository('org/project/_git/repo', 'https://dev.azure.com', 'azure'), scheme: 'basic', variable: 'ADO_APM_PAT' }
    ];
    for (const entry of cases) {
      const { auth } = authentication([{ repository: entry.repository, token: 'opaque-provider-token', username: 'token', scheme: entry.scheme }]);
      assert.deepEqual(await cliEnvironment(auth, ['marketplace', 'add', `${entry.repository.origin}/${entry.repository.path}`], home, home),
        { [entry.variable]: 'opaque-provider-token' });
    }
  });
});

test('mixed-account resolver operations fail before process startup, without retrying mutations', async () => {
  await fixture(async home => {
    await writeFile(join(home, 'apm.yml'), 'dependencies:\n  apm:\n    - team/repo-a\n    - team/repo-b\n');
    const { auth } = authentication([credential('team/repo-a', 'first-opaque-value'), credential('team/repo-b', 'second-opaque-value')]);
    const client = new ApmClient({ executable: '/must-not-start', cwd: home, home,
      environment: (args, cwd, signal) => cliEnvironment(auth, args, cwd, home, signal) });
    await assert.rejects(client.execute(['install']), /upstream APM repository-credential routing/);
    await assert.rejects(client.execute(['update', '--dry-run']), /cannot safely route/);
  });
});

test('one GitHub account can cover multiple explicitly declared repositories', async () => {
  await fixture(async home => {
    await writeFile(join(home, 'apm.yml'), 'dependencies:\n  apm:\n    - team/repo-a\n    - team/repo-b\n');
    const { auth } = authentication([credential('team/repo-a', 'shared-account'), credential('team/repo-b', 'shared-account')]);
    assert.deepEqual(await cliEnvironment(auth, ['install'], home, home), { GITHUB_APM_PAT: 'shared-account' });
  });
});

test('lockfile hosts and marketplace-qualified dependencies contribute authentication context', async () => {
  await fixture(async home => {
    await writeFile(join(home, 'apm.yml'), 'dependencies:\n  apm:\n    - plugin@first\n');
    await mkdir(join(home, '.apm', 'cache', 'marketplace'), { recursive: true });
    await writeFile(join(home, '.apm', 'cache', 'marketplace', 'first.json'), JSON.stringify({
      plugins: [{ name: 'plugin', source: { source: 'github', repo: 'other/plugin' } }]
    }));
    await writeFile(join(home, 'apm.lock.yaml'), JSON.stringify({
      dependencies: [{ host: 'git.example.test', repo_url: 'group/repo' }]
    }));
    const { auth, calls } = authentication();
    assert.deepEqual(await cliEnvironment(auth, ['outdated'], home, home), {});
    assert.deepEqual(calls[0], [
      repository('group/repo', 'https://git.example.test', 'gitlab'), repository('team/repo-a'), repository('other/plugin')
    ]);
  });
});

test('local lockfile identities never contribute CLI repository credentials', async () => {
  await fixture(async home => {
    await writeFile(join(home, 'apm.yml'), 'dependencies:\n  apm:\n    - team/repo-a/plugins/example\n');
    await writeFile(join(home, 'apm.lock.yaml'), JSON.stringify({ dependencies: [
      { source: 'local', repo_url: '_local/example', local_path: '/old/example' },
      { source: 'local', host: 'github.com', repo_url: 'team/local-copy', local_path: '/old/copy' },
      { host: 'github.com', repo_url: '_local/legacy' },
      { host: 'github.com', repo_url: 'team/repo-a', is_virtual: true, virtual_path: 'plugins/example' }
    ] }));
    const { auth, calls } = authentication([credential('team/repo-a', 'opaque-account-token')]);
    assert.deepEqual(await cliEnvironment(auth, ['outdated'], home, home), { GITHUB_APM_PAT: 'opaque-account-token' });
    assert.deepEqual(calls, [[repository('team/repo-a')]]);
  });
});

test('public and unmanaged repositories preserve CLI authentication fallback', async () => {
  await fixture(async home => {
    const { auth } = authentication();
    assert.deepEqual(await cliEnvironment(auth, ['install', 'team/public'], home, home), {});
  });
});

test('cancellation and malformed context stop credential lookup and process launch', async () => {
  await fixture(async home => {
    const { auth, calls } = authentication();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(cliEnvironment(auth, ['install'], home, home, controller.signal), /abort/i);
    await writeFile(join(home, 'apm.yml'), '[]');
    await assert.rejects(cliEnvironment(auth, ['install'], home, home), /expected an object/);
    assert.equal(calls.length, 0);
  });
});

test('legacy marketplace registrations on approved hosts resolve the same repository as the client', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apm-cli-auth-host-'));
  try {
    await mkdir(join(home, '.apm'));
    await writeFile(join(home, '.apm', 'marketplaces.json'), JSON.stringify({ marketplaces: [
      { name: 'hosted', host: 'git.example.test', owner: 'team', repo: 'catalog' }
    ] }));
    const { auth, calls } = authentication([]);
    await cliEnvironment(auth, ['marketplace', 'update', 'hosted'], home, home);
    assert.deepEqual(calls.at(-1), [repository('team/catalog', 'https://git.example.test', 'gitlab')]);
    const [registered] = await new ApmClient({ executable: process.execPath, cwd: home, home }).getMarketplaces();
    assert.equal(registered.source, 'git.example.test/team/catalog');
    assert.equal(registered.ref, 'main');
  } finally { await rm(home, { recursive: true, force: true }); }
});
