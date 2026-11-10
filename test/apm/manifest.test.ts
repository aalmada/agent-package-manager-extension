import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheShard, hasProjectManifest, marketplaceManifest, projectManifestPath, readContained, readProjectManifest } from '../../src/apm/manifest';

test('versioned cache identities match upstream URL normalization without auth material', () => {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
  assert.equal(cacheShard('https://GitHub.com/Owner/Repo.git'), hash('https://github.com/owner/repo'));
  assert.equal(cacheShard('git@gitea.example:Team/Repo.git'), hash('ssh://git@gitea.example/Team/Repo'));
  assert.equal(cacheShard('https://user:password@gitlab.com:443/Team/Repo.git'), hash('https://user@gitlab.com/team/repo'));
  assert.notEqual(cacheShard('https://gitea.example/Team/Repo'), cacheShard('https://gitea.example/team/repo'));
});
test('local manifest adapters retain unknown fields and reject escapes and oversized metadata', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apm-manifest-test-'));
  try {
    const root = join(home, 'market'); await mkdir(root);
    await writeFile(join(root, 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'one', futureField: 42 }] }));
    const snapshot = await marketplaceManifest({ name: 'local', source: root }, home);
    assert.equal((snapshot.manifest?.plugins as Record<string, unknown>[])[0].futureField, 42);
    await assert.rejects(readContained(root, '../secret'), /escapes/);
    await writeFile(join(home, 'outside.txt'), 'private');
    if (process.platform !== 'win32') {
      await symlink(join(home, 'outside.txt'), join(root, 'linked.txt'));
      await assert.rejects(readContained(root, 'linked.txt'), /symlink escapes/);
    }
    await writeFile(join(root, 'oversized.json'), Buffer.alloc(10 * 1024 * 1024 + 1));
    await assert.rejects(readContained(root, 'oversized.json'), /10 MB/);
  } finally { await rm(home, { recursive: true }); }
});

test('project manifest helpers read apm.yml freshly from the scope root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apm-project-'));
  try {
    assert.equal(projectManifestPath(root), join(root, 'apm.yml'));
    assert.equal(await hasProjectManifest(root), false);
    assert.equal(await readProjectManifest(root), undefined);
    await writeFile(join(root, 'apm.yml'), 'name: project\n');
    assert.equal(await hasProjectManifest(root), true);
    assert.equal(await readProjectManifest(root), 'name: project\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
