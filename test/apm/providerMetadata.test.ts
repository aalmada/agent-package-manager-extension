import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectRemotePackage, remoteSource, type RemoteSource } from '../../src/apm/packageMetadata';
import { remoteReader } from '../../src/apm/remoteMetadata';
import type { RepositoryHost } from '../../src/auth/repositories';

const hosts: readonly RepositoryHost[] = [
  { origin: 'https://code.example.com', provider: 'github' },
  { origin: 'https://git.example.com', provider: 'gitlab' },
  { origin: 'https://team.visualstudio.com', provider: 'azure' }
];
const marketplace = { name: 'catalog', source: 'https://github.com/org/catalog', host: 'github.com', ref: 'catalog/ref' };

function source(location: string, extra: Record<string, unknown> = {}): RemoteSource {
  const parsed = remoteSource({ source: 'git-subdir', url: location, path: 'plugins/demo', ref: 'feature/a #b', ...extra }, marketplace, hosts);
  assert.ok(parsed);
  return parsed;
}

function filePath(url: URL, provider: RemoteSource['repository']['provider']): string | undefined {
  if (provider === 'github') return url.pathname.includes('/contents/') ? decodeURIComponent(url.pathname.split('/contents/')[1]) : undefined;
  if (provider === 'gitlab') return url.pathname.includes('/files/') ? decodeURIComponent(url.pathname.split('/files/')[1].replace(/\/raw$/, '')) : undefined;
  return url.searchParams.has('path') ? url.searchParams.get('path')!.slice(1) : undefined;
}

function listing(provider: RemoteSource['repository']['provider'], paths: string[]): unknown {
  if (provider === 'azure') return { value: paths.map(path => ({ path: `/${path}`, gitObjectType: 'blob', isFolder: false })) };
  const entries = paths.map(path => ({ type: 'blob', path }));
  return provider === 'gitlab' ? entries : { tree: entries, truncated: false };
}

for (const [label, location, origin, provider] of [
  ['GitHub.com', 'https://github.com/org/project', 'https://api.github.com', 'github'],
  ['GitHub Enterprise', 'https://code.example.com/org/project', 'https://code.example.com', 'github'],
  ['GitLab', 'https://gitlab.com/group/subgroup/project', 'https://gitlab.com', 'gitlab'],
  ['Azure DevOps', 'https://dev.azure.com/org/project/_git/repo', 'https://dev.azure.com', 'azure']
] as const) {
  test(`${label} reads private metadata through the supplied fetcher at the exact pinned ref`, async () => {
    const remote = source(location, { sha: 'a'.repeat(40) });
    const paths = ['plugins/demo/plugin.json', 'plugins/demo/apm.yml', 'plugins/demo/README.md',
      'plugins/demo/skills/review/SKILL.md', 'plugins/demo/agents/planner.agent.md',
      'other/skills/secret/SKILL.md'];
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push(url.toString());
      assert.equal(url.origin, origin);
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal);
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      const file = filePath(url, provider);
      if (provider === 'github') {
        assert.ok(url.pathname.startsWith(label === 'GitHub.com' ? '/repos/' : '/api/v3/repos/'));
        if (file) {
          assert.equal(url.searchParams.get('ref'), 'a'.repeat(40));
          assert.equal(new Headers(init?.headers).get('accept'), 'application/vnd.github.raw+json');
        } else assert.ok(url.pathname.endsWith(`/git/trees/${'a'.repeat(40)}`));
      } else if (provider === 'gitlab') {
        assert.ok(url.pathname.startsWith('/api/v4/projects/group%2Fsubgroup%2Fproject/repository/'));
        assert.equal(url.searchParams.get('ref'), 'a'.repeat(40));
      } else {
        assert.equal(url.pathname, '/org/project/_apis/git/repositories/repo/items');
        assert.equal(url.searchParams.get('versionDescriptor.versionType'), 'commit');
        assert.equal(url.searchParams.get('versionDescriptor.version'), 'a'.repeat(40));
        if (!file) assert.equal(url.searchParams.get('recursionLevel'), 'Full');
        else assert.equal(url.searchParams.get('download'), 'true');
      }
      if (!file) return Response.json(listing(provider, paths));
      if (file === 'plugins/demo/plugin.json') return Response.json({ name: 'demo', skills: ['./skills/review/'] });
      if (file === 'plugins/demo/apm.yml') return new Response('name: demo\nversion: 1.2.3\n');
      if (file === 'plugins/demo/README.md') return new Response('# Demo');
      if (file === 'plugins/demo/skills/review/SKILL.md') return new Response('---\nname: Review\ndescription: Review changes.\n---\n');
      if (file === 'plugins/demo/agents/planner.agent.md') return new Response('---\ndescription: Make a plan.\n---\n');
      return new Response(null, { status: 404 });
    };
    const details = await inspectRemotePackage(remote, fetcher);
    assert.equal(details.pluginManifest?.name, 'demo');
    assert.equal(details.manifest?.version, '1.2.3');
    assert.equal(details.readme, '# Demo');
    assert.deepEqual(details.contents.map(group => [group.kind, group.items.map(item => [item.name, item.description])]), [
      ['skills', [['Review', 'Review changes.']]], ['agents', [['planner', 'Make a plan.']]]
    ]);
    assert.deepEqual(details.notices, []);
    assert.ok(!requests.some(url => url.includes('raw.githubusercontent.com') || url.includes('other/skills')));
  });
}

test('relative plugin paths inherit repository and marketplace refs, while external sources preserve pins', () => {
  for (const [location, provider] of [
    ['https://github.com/org/catalog', 'github'], ['https://code.example.com/org/catalog', 'github'],
    ['https://gitlab.com/group/catalog', 'gitlab'], ['https://dev.azure.com/org/project/_git/catalog', 'azure']
  ]) {
    const remote = remoteSource('./plugins/demo/', { name: 'catalog', source: location, ref: 'release/a' }, hosts);
    assert.equal(remote?.repository.provider, provider);
    assert.equal(remote?.path, 'plugins/demo');
    assert.equal(remote?.ref, 'release/a');
  }
  assert.equal(remoteSource('plugins/demo', { ...marketplace, source: `${marketplace.source}#release%2Fa`, ref: undefined })?.ref, 'release/a');
  for (const kind of ['git', 'git-subdir', 'github']) {
    assert.equal(source('https://github.com/org/project.git#release%2Fa', { source: kind, ref: undefined }).ref, 'release/a');
    assert.equal(source('https://github.com/org/project', { source: kind, sha: 'b'.repeat(40), ref: 'ignored' }).ref, 'b'.repeat(40));
  }
  assert.equal(remoteSource({ source: 'github', repo: 'org/project', host: 'code.example.com' }, marketplace, hosts)?.repository.origin, 'https://code.example.com');
  assert.equal(remoteSource({ source: 'gitlab', repo: 'group/sub/project' }, marketplace)?.repository.origin, 'https://gitlab.com');
  assert.equal(remoteSource({ source: 'azure', repo: 'org/project/_git/repo', host: 'dev.azure.com' }, marketplace)?.repository.provider, 'azure');
  for (const [kind, repo, origin] of [
    ['github', 'github.com/org/project', 'https://github.com'],
    ['github', 'code.example.com/org/project', 'https://code.example.com'],
    ['gitlab', 'gitlab.com/group/sub/project', 'https://gitlab.com'],
    ['gitlab', 'git.example.com/group/sub/project', 'https://git.example.com']
  ]) {
    assert.equal(remoteSource({ source: kind, repo }, marketplace, hosts)?.repository.origin, origin);
  }
  assert.equal(source('https://git.example.com/group/sub/project').repository.origin, 'https://git.example.com');
  assert.equal(source('https://team.visualstudio.com/project/_git/repo').repository.provider, 'azure');
  assert.equal(remoteSource('plugins/demo', { ...marketplace, source: 'org/catalog', host: 'code.example.com' }, hosts)?.repository.origin,
    'https://code.example.com');
});

test('unknown enterprise hosts, provider mismatches and escaping package paths never produce requests', () => {
  assert.equal(remoteSource({ source: 'github', repo: 'org/project', host: 'unapproved.example' }, marketplace), undefined);
  assert.equal(remoteSource('./plugin', { ...marketplace, source: 'https://unapproved.example/org/project' }), undefined);
  assert.equal(remoteSource('./plugin', { ...marketplace, source: 'org/project', host: 'unapproved.example' }), undefined);
  assert.equal(remoteSource({ source: 'github', url: 'https://gitlab.com/org/project' }, marketplace), undefined);
  assert.equal(remoteSource({ source: 'git', url: 'https://user:secret@github.com/org/project' }, marketplace), undefined);
  for (const path of ['/', '../private', '/private', 'plugins/../private', 'plugins\\private', 'plugins/\0private']) {
    assert.throws(() => remoteSource(path, marketplace), /unsafe/);
  }
  assert.throws(() => remoteSource('./plugin', { ...marketplace, ref: 'branch\nname' }), /unsafe repository ref/);
});

test('branch and tag names and plugin paths are encoded without changing their meaning', async () => {
  for (const location of ['https://github.com/org/project', 'https://code.example.com/org/project',
    'https://gitlab.com/group/sub/project', 'https://dev.azure.com/org/project/_git/repo']) {
    const remote = source(location, { path: 'plugins/a #b' });
    const reader = remoteReader(remote, async input => {
      const url = new URL(String(input));
      const file = filePath(url, remote.repository.provider);
      if (!file) return Response.json(listing(remote.repository.provider, ['plugins/a #b/README.md']));
      assert.equal(file, 'plugins/a #b/README.md');
      assert.equal(url.searchParams.get(remote.repository.provider === 'azure' ? 'versionDescriptor.version' : 'ref'), 'feature/a #b');
      return new Response('readme');
    });
    assert.equal(await reader.read('README.md'), 'readme');
  }
  const remote = source('https://dev.azure.com/org/project/_git/repo', { ref: 'refs/tags/release/a' });
  await remoteReader(remote, async input => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('versionDescriptor.versionType'), 'tag');
    assert.equal(url.searchParams.get('versionDescriptor.version'), 'release/a');
    return Response.json({ value: [] });
  }).tree();
});

test('GitLab follows numbered tree pagination and keeps root-relative composition', async () => {
  const remote = source('https://gitlab.com/group/sub/project');
  const pages: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    const file = filePath(url, 'gitlab');
    if (!file) {
      pages.push(url.searchParams.get('page')!);
      if (pages.length === 1) return Response.json([{ type: 'blob', path: 'plugins/demo/plugin.json' }], { headers: { 'x-next-page': '2' } });
      return Response.json([{ type: 'blob', path: 'skills/shared/SKILL.md' }], { headers: { 'x-next-page': '' } });
    }
    if (file === 'plugins/demo/plugin.json') return Response.json({
      name: 'demo', extensions: { 'com.github.awesome-copilot': { skills: ['./skills/shared/', './skills/missing/'] } }
    });
    if (file === 'skills/shared/SKILL.md') return new Response('---\ndescription: Shared skill.\n---\n');
    return new Response(null, { status: 404 });
  };
  const details = await inspectRemotePackage(remote, fetcher);
  assert.deepEqual(pages, ['1', '2']);
  assert.equal(details.contents[0].items[0].description, 'Shared skill.');
  assert.match(details.notices.join('\n'), /1 declared content was not found/);
  assert.equal(details.notes?.length, 1);
});

test('Azure file reads require exact file casing and do not download directories or ambiguous paths', async () => {
  const remote = source('https://dev.azure.com/org/project/_git/repo');
  const downloaded: string[] = [];
  const reader = remoteReader(remote, async input => {
    const url = new URL(String(input)), file = filePath(url, 'azure');
    if (!file) return Response.json({ value: [
      { path: '/plugins/demo/Readme.md', gitObjectType: 'blob', isFolder: false },
      { path: '/plugins/demo/agents', gitObjectType: 'tree', isFolder: true }
    ] });
    downloaded.push(file);
    return new Response('correct');
  });
  assert.equal(await reader.read('README.md'), undefined);
  assert.equal(await reader.read('agents'), undefined);
  assert.equal(await reader.read('Readme.md'), 'correct');
  assert.deepEqual(downloaded, ['plugins/demo/Readme.md']);
});

test('Azure project and repository names are encoded, including approved visualstudio origins', async () => {
  for (const [location, expected] of [
    ['https://dev.azure.com/org/my%20project/_git/my%20repo', '/org/my%20project/_apis/git/repositories/my%20repo/items'],
    ['https://team.visualstudio.com/my%20project/_git/my%20repo', '/my%20project/_apis/git/repositories/my%20repo/items']
  ]) {
    const remote = source(location);
    await remoteReader(remote, async input => {
      assert.equal(new URL(String(input)).pathname, expected);
      return Response.json({ value: [] });
    }).tree();
  }
});

test('Azure never downloads content from incomplete or unavailable listings', async () => {
  for (const response of [
    new Response(null, { status: 404 }),
    Response.json({ value: [], truncated: true }),
    Response.json({ value: [] }, { headers: { 'x-ms-continuationtoken': 'next' } })
  ]) {
    let requests = 0;
    const reader = remoteReader(source('https://dev.azure.com/org/project/_git/repo'), async input => {
      requests++;
      assert.equal(new URL(String(input)).searchParams.has('path'), false);
      return response;
    });
    await assert.rejects(reader.read('README.md'), /Cannot verify the exact Azure DevOps file path/);
    assert.equal(requests, 1);
  }
});

test('alternate README casing uses only the exact path reported by the repository tree', async () => {
  const details = await inspectRemotePackage(source('https://dev.azure.com/org/project/_git/repo'), async input => {
    const url = new URL(String(input)), file = filePath(url, 'azure');
    if (!file) return Response.json(listing('azure', ['plugins/demo/Readme.md']));
    assert.equal(file, 'plugins/demo/Readme.md');
    return new Response('# Case-preserved README');
  });
  assert.equal(details.readme, '# Case-preserved README');
});

test('404s, authentication failures and server failures remain explicit and host-neutral', async () => {
  for (const status of [404, 401, 403, 429, 500]) {
    const details = await inspectRemotePackage(source('https://gitlab.com/group/project'), async () => new Response(null, { status }));
    assert.deepEqual(details.contents, []);
    assert.match(details.notices.join('\n'), new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(details.notices.join('\n'), /public|GitHub/);
    if (status === 401 || status === 403) assert.match(details.notices.join('\n'), /Sign in.*account.*access/);
    else assert.doesNotMatch(details.notices.join('\n'), /Sign in/);
  }
  const details = await inspectRemotePackage(source('https://github.com/org/project'), async () => { throw new Error('Request timed out.'); });
  assert.match(details.notices.join('\n'), /timed out/);
});

test('invalid listings and pagination are reported instead of being treated as an empty repository', async () => {
  for (const [body, headers] of [[{}, {}], [[{ type: 'blob', path: '../secret' }], {}],
    [[], { 'x-next-page': '1' }]] as const) {
    const details = await inspectRemotePackage(source('https://gitlab.com/group/project'), async input =>
      new URL(String(input)).pathname.endsWith('/tree') ? Response.json(body, { headers }) : new Response(null, { status: 404 }));
    assert.match(details.notices.join('\n'), /invalid repository listing|unsafe|invalid tree pagination/);
  }
});

test('metadata, trees and frontmatter enforce byte limits while bounded frontmatter ignores large bodies', async () => {
  const remote = source('https://github.com/org/project');
  const reader = remoteReader(remote, async input => {
    const url = new URL(String(input)), file = filePath(url, 'github');
    if (!file) return new Response(' '.repeat(5 * 1024 * 1024 + 1));
    if (file.endsWith('large.md')) return new Response('---\ndescription: ' + 'x'.repeat(64 * 1024));
    if (file.endsWith('bounded.md')) return new Response('---\ndescription: Short.\n---\n' + 'x'.repeat(128 * 1024));
    return new Response('x'.repeat(file.endsWith('README.md') ? 2 * 1024 * 1024 + 1 : 1024 * 1024 + 1));
  });
  await assert.rejects(reader.read('README.md', 2 * 1024 * 1024), /display size limit/);
  await assert.rejects(reader.read('plugin.json'), /display size limit/);
  await assert.rejects(reader.tree(), /display size limit/);
  await assert.rejects(reader.read('large.md', undefined, true), /64 KB/);
  assert.equal(await reader.read('bounded.md', undefined, true), '---\ndescription: Short.\n---\n');
});

test('description request and tree pagination caps produce visible incomplete-result notices', async () => {
  const remote = source('https://github.com/org/project');
  let descriptions = 0;
  const details = await inspectRemotePackage(remote, async input => {
    const url = new URL(String(input)), file = filePath(url, 'github');
    if (!file) return Response.json(listing('github', Array.from({ length: 252 }, (_, i) => `plugins/demo/agents/agent${i}.md`)));
    if (file.endsWith('.md') && !file.endsWith('README.md')) { descriptions++; return new Response('---\ndescription: Agent.\n---\n'); }
    return new Response(null, { status: 404 });
  });
  assert.equal(descriptions, 250);
  assert.match(details.notices.join('\n'), /2 additional contents/);
  let pages = 0;
  const tree = await remoteReader(source('https://gitlab.com/group/project'), async () => {
    pages++;
    return Response.json([{ type: 'blob', path: `agent${pages}.md` }], { headers: { 'x-next-page': String(pages + 1) } });
  }).tree();
  assert.equal(pages, 100);
  assert.equal(tree?.truncated, true);
});

test('truncated GitHub trees and description failures retain declared contents with explicit notices', async () => {
  const details = await inspectRemotePackage(source('https://github.com/org/project'), async input => {
    const url = new URL(String(input)), file = filePath(url, 'github');
    if (!file) return Response.json({ tree: [{ type: 'blob', path: 'plugins/demo/agents/planner.md' }], truncated: true });
    if (file.endsWith('planner.md')) return new Response(null, { status: 503 });
    if (file.endsWith('plugin.json')) return Response.json({ name: 'demo' });
    return new Response(null, { status: 404 });
  });
  assert.equal(details.contents[0].items[0].name, 'planner');
  assert.match(details.notices.join('\n'), /truncated/);
  assert.match(details.notices.join('\n'), /Could not load descriptions.*HTTP 503/);
});
