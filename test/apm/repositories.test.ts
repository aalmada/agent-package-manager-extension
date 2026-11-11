import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repositoryForRequest, repositoryFromPackageSource, repositoryFromSource, repositoryProbeUrl } from '../../src/auth/repositories';

test('repository sources normalize transport and preserve provider-specific paths', () => {
  for (const source of ['owner/repo', 'github.com/owner/repo', 'https://github.com/owner/repo.git#main', 'git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo']) {
    assert.deepEqual(repositoryFromSource(source), { provider: 'github', origin: 'https://github.com', path: 'owner/repo' });
  }
  assert.equal(repositoryFromSource('https://gitlab.com/group/subgroup/repo')?.path, 'group/subgroup/repo');
  const azure = repositoryFromSource('https://dev.azure.com/org/project/_git/repo')!;
  assert.equal(repositoryProbeUrl(azure), 'https://dev.azure.com/org/project/_apis/git/repositories/repo?api-version=7.1');
  assert.deepEqual(repositoryFromSource('git@ssh.dev.azure.com:v3/org/project/repo.git'), azure);
  assert.deepEqual(repositoryFromSource('ssh://git@ssh.dev.azure.com/v3/org/project/repo'), azure);
  const hosts = [{ origin: 'https://org.visualstudio.com', provider: 'azure' as const }];
  const legacy = repositoryFromSource('https://org.visualstudio.com/project/_git/repo', hosts)!;
  assert.equal(repositoryProbeUrl(legacy), 'https://org.visualstudio.com/project/_apis/git/repositories/repo?api-version=7.1');
  const spaces = repositoryFromSource('https://dev.azure.com/org/my%20project/_git/my%20repo')!;
  assert.equal(spaces.path, 'org/my project/_git/my repo');
  assert.equal(repositoryProbeUrl(spaces), 'https://dev.azure.com/org/my%20project/_apis/git/repositories/my%20repo?api-version=7.1');
});

test('repository parsing rejects credentials, traversal and unapproved origins', () => {
  for (const source of ['https://user:token@github.com/a/b', 'https://user@github.com/a/b',
    'https://github.com/a/../b', 'https://github.com/a/%2e%2e/b', 'https://github.com/a/b?token=secret',
    'http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://github.com:444/a/b',
    'https://gitlab.com/a/./b', 'https://enterprise.test/a/b', 'ssh://token@github.com/a/b']) {
    assert.equal(repositoryFromSource(source), undefined, source);
  }
  assert.equal(repositoryFromSource('https://enterprise.test/a/b', [{ origin: 'https://enterprise.test', provider: 'github' }])?.origin, 'https://enterprise.test');
});

test('direct GitHub package paths resolve to their validated repository root', () => {
  const expected = { provider: 'github', origin: 'https://github.com', path: 'owner/repo' };
  for (const source of ['owner/repo/plugins/one#release', 'github.com/owner/repo/plugins/one',
    'https://github.com/owner/repo.git/plugins/one#v1', 'git@github.com:owner/repo/plugins/one',
    'ssh://git@github.com/owner/repo/plugins/one']) {
    assert.deepEqual(repositoryFromPackageSource(source), expected, source);
  }
  for (const source of ['https://user@github.com/owner/repo/plugin', 'owner/repo/../other',
    'owner/repo/%2e%2e/other', 'owner/repo/a%2fb', 'owner/repo/a//b',
    'https://github.com.evil.test/owner/repo/plugin', 'owner/repo/plugin?token=secret']) {
    assert.equal(repositoryFromPackageSource(source), undefined, source);
  }
  assert.equal(repositoryFromPackageSource('https://gitlab.com/group/subgroup/repo')?.path, 'group/subgroup/repo');
});

test('metadata request routes identify exactly one contained repository', () => {
  assert.equal(repositoryForRequest(new URL('https://api.github.com/repos/org/a/contents/apm.yml'))?.path, 'org/a');
  assert.equal(repositoryForRequest(new URL('https://api.github.com/repos/org/ab/git/trees/HEAD'))?.path, 'org/ab');
  assert.equal(repositoryForRequest(new URL('https://raw.githubusercontent.com/org/a/main/apm.yml'))?.path, 'org/a');
  assert.equal(repositoryForRequest(new URL('https://gitlab.com/api/v4/projects/group%2Fsub%2Frepo/repository/files/apm.yml/raw'))?.path, 'group/sub/repo');
  assert.equal(repositoryForRequest(new URL('https://dev.azure.com/org/project/_apis/git/repositories/repo/items?path=/apm.yml'))?.path, 'org/project/_git/repo');
  for (const url of ['https://api.github.com/user', 'https://api.github.com/repos/org/a/issues',
    'https://evil.test/repos/org/a', 'https://user@api.github.com/repos/org/a',
    'https://api.github.com/repos/org/a%2Fb', 'http://api.github.com/repos/org/a']) {
    assert.equal(repositoryForRequest(new URL(url)), undefined, url);
  }
});
