import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { ApmClient } from '../../src/apm/client';
import { recoveryActions } from '../../src/apm/workflows';
import { cliEnvironment } from '../../src/auth/cli';
import type { Repository } from '../../src/auth/repositories';
import type { Marketplace } from '../../src/apm/types';

const source = buildSync({
  entryPoints: ['src/authentication.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode']
}).outputFiles[0].text;
const nodeRequire = createRequire(resolve('test/apm/repositoryAuthentication.test.ts'));
type Api = typeof import('../../src/authentication');
const repo = (name: string): Repository => ({ provider: 'github', origin: 'https://github.com', path: `org/${name}` });

function harness() {
  const state = {
    trusted: true, enterprise: '', accounts: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }],
    tokens: new Map([['one', 'token-one'], ['two', 'token-two']]), providerError: undefined as Error | undefined,
    respond: (() => new Response('', { status: 404 })) as (url: string, headers: Headers) => Response,
    picks: [] as (string | undefined)[], inputs: [] as string[], sessionWait: undefined as Promise<void> | undefined,
    marketplaceSettings: [] as string[], registered: [] as Marketplace[], workspaceRoot: undefined as string | undefined,
    shownChoices: [] as string[][], warnings: [] as string[]
  };
  const calls: { provider: string; options: { silent?: boolean; account?: { id: string }; createIfNone?: boolean } }[] = [];
  const requests: { url: string; headers: Headers; options: RequestInit }[] = [];
  const values = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  let secretListener: ((event: { key: string }) => void) | undefined;
  const context = {
    globalState: { get: <T>(key: string, fallback: T) => values.get(key) ?? fallback, update: async (key: string, value: unknown) => { values.set(key, value); } },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => { secrets.set(key, value); secretListener?.({ key }); },
      delete: async (key: string) => { secrets.delete(key); secretListener?.({ key }); },
      onDidChange: (listener: typeof secretListener) => { secretListener = listener; return { dispose() { secretListener = undefined; } }; }
    }
  };
  const module = { exports: {} };
  runInNewContext(source, {
    module, exports: module.exports, URL, Headers, Buffer, Date,
    require: (id: string) => id === 'vscode' ? {
      EventEmitter: class {
        listeners = new Set<() => void>();
        event = (listener: () => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
        fire() { for (const listener of this.listeners) listener(); }
        dispose() { this.listeners.clear(); }
      },
      env: { remoteName: 'test-remote' },
      workspace: { get isTrusted() { return state.trusted; }, getConfiguration: () => ({ get: () => state.enterprise }) },
      authentication: {
        getAccounts: async () => state.accounts,
        getSession: async (provider: string, _scopes: string[], options: { silent?: boolean; account?: { id: string }; createIfNone?: boolean }) => {
          calls.push({ provider, options });
          await state.sessionWait;
          if (state.providerError) throw state.providerError;
          const account = options.account ?? state.accounts[0];
          const accessToken = state.tokens.get(account.id);
          return accessToken ? { accessToken, account } : undefined;
        }
      },
      window: {
        showQuickPick: async (items: (string | { label: string })[]) => {
          state.shownChoices.push(Array.from(items, item => typeof item === 'string' ? item : item.label));
          const selection = state.picks.shift();
          return items.find(item => (typeof item === 'string' ? item : item.label) === selection);
        },
        showInputBox: async () => state.inputs.shift(),
        showInformationMessage: async () => undefined,
        showWarningMessage: async (message: string) => { state.warnings.push(message); }
      }
    } : nodeRequire(id),
    fetch: async (url: string, options: RequestInit) => {
      const headers = new Headers(options.headers);
      requests.push({ url, headers, options });
      return state.respond(url, headers);
    }
  });
  const api = module.exports as Api;
  const auth = new api.RepositoryAuthentication(context as unknown as ConstructorParameters<Api['RepositoryAuthentication']>[0],
    async () => ({ settings: state.marketplaceSettings, registered: state.registered, workspaceRoot: state.workspaceRoot }));
  return { api, auth, state, calls, requests, values, secrets, context };
}

async function marketplaceFixture(pluginRepository: string, operation: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'apm-rate-limit-'));
  try {
    const cache = join(home, '.apm', 'cache', 'marketplace');
    await mkdir(cache, { recursive: true });
    await writeFile(join(home, '.apm', 'marketplaces.json'), JSON.stringify({
      marketplaces: [{ name: 'intelligentium', owner: 'org', repo: 'a' }]
    }));
    await writeFile(join(cache, 'intelligentium.json'), JSON.stringify({
      plugins: [{ name: 'agent-authoring', source: { source: 'github', repo: pluginRepository } }]
    }));
    await operation(home);
  } finally { await rm(home, { recursive: true, force: true }); }
}

test('two repositories in one organization select different Accounts using repository-root probes', async () => {
  const host = harness();
  const generation = host.auth.generation;
  let changes = 0;
  host.auth.onDidChange(() => { changes++; });
  host.state.respond = (url, headers) => {
    const token = headers.get('Authorization');
    return new Response('', { status: (url.endsWith('/a') ? token === 'Bearer token-one' : token === 'Bearer token-two') ? 200 : 404 });
  };
  const credentials = await host.auth.credentials([repo('a'), repo('b'), repo('a')]);
  assert.deepEqual(Array.from(credentials, item => item.token), ['token-one', 'token-two']);
  assert.equal(host.auth.knownRepositories().length, 2);
  assert.equal(host.auth.generation, generation);
  assert.equal(changes, 0);
  assert.ok(host.calls.every(call => call.options.silent === true && !call.options.createIfNone && call.options.account));
  assert.ok([...host.values.values()].every(value => !JSON.stringify(value).includes('token-')));
  const count = host.requests.length;
  await host.auth.credentials([repo('b')]);
  assert.equal(host.requests[count].headers.get('Authorization'), 'Bearer token-two');
});

test('permission denial and unavailable silent consent rotate to the next authorized account', async () => {
  const host = harness();
  host.state.respond = (_url, headers) => new Response('', { status: headers.get('Authorization') === 'Bearer token-two' ? 200 : headers.has('Authorization') ? 403 : 401 });
  assert.equal((await host.auth.credentials([repo('a')]))[0].token, 'token-two');
  host.state.tokens.delete('one');
  assert.equal((await host.auth.credentials([repo('b')]))[0].token, 'token-two');
  assert.ok(host.calls.every(call => call.options.silent));
});

test('repository picker offers configured and registered marketplaces and known repositories without network discovery', async () => {
  const host = harness();
  host.state.respond = (_url, headers) => new Response('', { status: headers.has('Authorization') ? 200 : 404 });
  await host.auth.credentials([repo('known')]);
  host.requests.length = 0;
  host.state.marketplaceSettings = [
    'private=NTT-EMEAL-COPILOT-IBIOL/sdlc-plugins#main', 'org/catalog', '/tmp/local-marketplace',
    'https://example.test/marketplace.json', 'https://user@example.com/invalid'
  ];
  host.state.registered = [
    { name: 'catalog', source: 'https://github.com/org/catalog.git' },
    { name: 'other', source: 'org/other' }
  ];
  host.state.picks.push('Connect GitHub account', 'https://github.com/NTT-EMEAL-COPILOT-IBIOL/sdlc-plugins');
  await host.auth.manage();
  const choices = host.state.shownChoices[1];
  assert.deepEqual(choices, [
    'https://github.com/org/known', 'https://github.com/org/catalog', 'https://github.com/org/other',
    'https://github.com/NTT-EMEAL-COPILOT-IBIOL/sdlc-plugins', 'Enter another repository...'
  ]);
  assert.equal(host.requests.length, 1, 'Only the chosen credential is probed');
  assert.equal(host.requests[0].url, 'https://api.github.com/repos/NTT-EMEAL-COPILOT-IBIOL/sdlc-plugins');
  assert.equal(host.state.warnings.length, 1);
  assert.ok(host.state.warnings.every(message => !message.includes('user@')));
  assert.equal(host.state.inputs.length, 0);
});

test('repository picker cancellation never requests credentials or probes access', async () => {
  const host = harness();
  host.state.marketplaceSettings = ['org/catalog'];
  host.state.picks.push('Add repository token', undefined);
  await host.auth.manage();
  assert.equal(host.requests.length, 0);
  assert.equal(host.calls.length, 0);
  assert.equal(host.secrets.size, 0);
});

test('repository picker discovers remote dependencies but excludes local lockfile identities', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apm-auth-picker-'));
  try {
    await writeFile(join(home, 'apm.yml'), 'dependencies:\n  apm:\n    - org/direct/plugins/one#main\n    - plugin@market\n');
    await writeFile(join(home, 'apm.lock.yaml'), JSON.stringify({ dependencies: [
      { host: 'github.com', repo_url: 'org/locked' },
      { source: 'local', repo_url: '_local/plugin', local_path: '/old/plugin' },
      { source: 'local', host: 'github.com', repo_url: 'org/local-copy', local_path: '/old/copy' },
      { host: 'github.com', repo_url: '_local/legacy' }
    ] }));
    const host = harness();
    host.state.picks.push('Connect GitHub account', undefined);
    await host.auth.manage(undefined, home);
    assert.deepEqual(host.state.shownChoices[1], ['https://github.com/org/direct', 'https://github.com/org/locked', 'Enter another repository...']);
    assert.equal(host.requests.length, 0);
    assert.equal(host.calls.length, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('contextual recovery selects the failed repository without another repository prompt', async () => {
  const host = harness();
  host.state.picks.push('Connect GitHub account');
  host.state.respond = (_url, headers) => new Response('', { status: headers.has('Authorization') ? 200 : 404 });
  await host.auth.manage(repo('direct'));
  assert.equal(host.state.shownChoices.length, 1);
  assert.equal(host.requests[0].url, 'https://api.github.com/repos/org/direct');
  assert.ok(host.calls[0].options.createIfNone);
});

test('repository picker supports tokens for registered non-GitHub marketplaces', async () => {
  const host = harness();
  host.state.registered = [{ name: 'catalog', source: 'https://gitlab.com/group/catalog' }];
  host.state.picks.push('Add repository token', 'https://gitlab.com/group/catalog');
  host.state.inputs.push('private-pat');
  host.state.respond = (_url, headers) => new Response('', { status: headers.get('PRIVATE-TOKEN') === 'private-pat' ? 200 : 401 });
  await host.auth.manage();
  assert.equal(host.requests.length, 1);
  assert.equal(host.requests[0].url, 'https://gitlab.com/api/v4/projects/group%2Fcatalog');
  assert.equal(host.secrets.size, 1);
});

test('private marketplace credentials rotate on expiry and recover after reauthorization', async () => {
  const host = harness();
  await marketplaceFixture('org/a', async home => {
    host.state.respond = (_url, headers) => {
      const token = headers.get('Authorization');
      return new Response('', { status: token === 'Bearer token-one' || token === 'Bearer token-two' ? 200 : 404 });
    };
    const args = ['marketplace', 'update', 'intelligentium'];
    assert.equal((await cliEnvironment(host.auth, args, home, home)).GITHUB_APM_PAT, 'token-one');
    host.state.tokens.set('one', 'expired');
    assert.equal((await cliEnvironment(host.auth, args, home, home)).GITHUB_APM_PAT, 'token-two');
    host.state.tokens.set('two', 'expired');
    await assert.rejects(cliEnvironment(host.auth, args, home, home), error => {
      assert.match(String(error), /APM: Manage Repository Accounts/);
      assert.ok(recoveryActions(String(error)).includes('authentication'));
      return true;
    });
    host.state.tokens.set('one', 'token-one');
    host.auth.invalidate();
    assert.equal((await cliEnvironment(host.auth, args, home, home)).GITHUB_APM_PAT, 'token-one');
  });
});

test('direct private subdirectory installs select another authorized account after expiry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apm-private-auth-'));
  try {
    const host = harness();
    host.state.respond = (_url, headers) => {
      const token = headers.get('Authorization');
      return new Response('', { status: token === 'Bearer token-one' || token === 'Bearer token-two' ? 200 : 404 });
    };
    const args = ['install', 'org/a/plugins/private#main'];
    assert.equal((await cliEnvironment(host.auth, args, home, home)).GITHUB_APM_PAT, 'token-one');
    host.state.tokens.set('one', 'expired');
    assert.equal((await cliEnvironment(host.auth, args, home, home)).GITHUB_APM_PAT, 'token-two');
    assert.ok(host.requests.every(request => request.url === 'https://api.github.com/repos/org/a'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('known private metadata uses one authenticated file request and cached read-only probes', async t => {
  const host = harness();
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  host.state.respond = (_url, headers) => new Response('', { status: headers.has('Authorization') ? 200 : 404 });
  await host.auth.credentials([repo('a')]);
  const start = host.requests.length;
  for (let i = 0; i < 10; i++) {
    await host.auth.fetch(`https://api.github.com/repos/org/a/contents/file${i}`, { signal: new AbortController().signal });
  }
  assert.equal(host.requests.length - start, 10, 'Exactly one HTTP request per file, with no anonymous retries or access probes');
  assert.ok(host.requests.slice(start).every(request => request.headers.has('Authorization')));
  now += 5 * 60_000;
  await host.auth.fetch('https://api.github.com/repos/org/a/contents/next');
  assert.equal(host.requests.length - start, 12, 'Read-only probes expire after five minutes');
  const beforeMutation = host.requests.length;
  await host.auth.credentials([repo('a')]);
  assert.equal(host.requests.length - beforeMutation, 1, 'CLI credentials always run a fresh access probe');
  assert.ok(host.requests.at(-1)?.headers.has('Authorization'), 'Known private repositories do not probe the rate-limited anonymous API');
  host.auth.invalidate();
  const beforeInvalidation = host.requests.length;
  await host.auth.fetch('https://api.github.com/repos/org/a/contents/next');
  assert.equal(host.requests.length - beforeInvalidation, 2, 'Account changes invalidate cached access decisions');
});

test('changing a token bypasses cached access decisions and private denials are surfaced', async () => {
  const host = harness();
  host.state.accounts = [host.state.accounts[0]];
  host.state.respond = (_url, headers) => new Response('', { status: headers.has('Authorization') ? 200 : 404 });
  await host.auth.credentials([repo('a')]);
  host.state.tokens.set('one', 'changed-token');
  const count = host.requests.length;
  await host.auth.fetch('https://api.github.com/repos/org/a/contents/next');
  assert.equal(host.requests.length - count, 2, 'Token rotation requires another probe');
  host.state.respond = () => new Response('', { status: 401 });
  await assert.rejects(host.auth.fetch('https://api.github.com/repos/org/a/contents/next'), /access denied/);
});

test('anonymous rate limits use a verified account without persisting an unconfirmed binding', async () => {
  for (const response of [
    () => new Response('', { status: 429 }),
    () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
  ]) {
    const host = harness();
    host.state.respond = (_url, headers) => headers.has('Authorization') ? new Response('') : response();
    assert.equal((await host.auth.credentials([repo('a')]))[0].token, 'token-one');
    assert.equal(host.requests.length, 2);
    assert.equal(host.requests[0].headers.has('Authorization'), false);
    assert.equal(host.requests[1].headers.get('Authorization'), 'Bearer token-one');
    assert.ok(host.calls.every(call => call.options.silent && !call.options.createIfNone));
    assert.equal(host.auth.knownRepositories().length, 0);
    await host.auth.credentials([repo('a')]);
    assert.equal(host.requests.length, 4, 'CLI credential selection always probes access freshly');
  }
});

test('anonymous rate limits use verified credentials for metadata without repeating the anonymous probe', async () => {
  const host = harness();
  host.state.respond = (url, headers) => !headers.has('Authorization')
    ? new Response('', { status: 429, headers: { 'retry-after': '60' } })
    : new Response(url.includes('/contents/') ? 'metadata' : '');
  const url = 'https://api.github.com/repos/org/a/contents/apm.yml';
  assert.equal(await (await host.auth.fetch(url)).text(), 'metadata');
  assert.equal(host.requests.length, 3);
  assert.equal(host.requests[0].url, url);
  assert.equal(host.requests[0].headers.has('Authorization'), false);
  assert.equal(host.requests[1].url, 'https://api.github.com/repos/org/a');
  assert.equal(host.requests[1].headers.get('Authorization'), 'Bearer token-one');
  assert.equal(host.requests[2].url, url);
  assert.equal(host.requests[2].headers.get('Authorization'), 'Bearer token-one');
  assert.ok(host.requests.every(request => request.options.redirect === 'error' && request.options.credentials === 'omit'));
  assert.equal(host.auth.knownRepositories().length, 0);
  await host.auth.fetch('https://api.github.com/repos/org/a/contents/README.md');
  assert.equal(host.requests.length, 5, 'The authenticated read-only access probe is reused');
});

test('anonymous rate limits remain explicit when no account can be verified', async () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  for (const accounts of [[], [{ id: 'one', label: 'One' }]]) {
    const host = harness();
    host.state.accounts = accounts;
    host.state.respond = (_url, headers) => headers.has('Authorization') ? new Response('', { status: 404 }) :
      new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } });
    await assert.rejects(host.auth.credentials([repo('a')]), error => {
      assert.match(String(error), /anonymous requests/i);
      assert.match(String(error), /APM: Manage Repository Accounts/);
      assert.match(String(error), new RegExp(new Date(reset * 1000).toISOString().replaceAll('.', '\\.')));
      assert.ok(recoveryActions(String(error)).includes('authentication'));
      return true;
    });
    assert.equal(host.requests.length, accounts.length + 1);
    assert.equal(host.auth.knownRepositories().length, 0);
  }
  const host = harness();
  host.state.accounts = [];
  host.state.respond = () => new Response('', { status: 429 });
  await assert.rejects(host.auth.fetch('https://api.github.com/repos/org/a/contents/apm.yml'), /rate limit.*anonymous/i);
  assert.equal(host.requests.length, 1);
});

test('rate-limit diagnostics honor retry headers and reject invalid reset times', async t => {
  const now = Date.UTC(2030, 0, 1);
  t.mock.method(Date, 'now', () => now);
  const cases: { headers: Record<string, string>; expected: string }[] = [
    { headers: { 'retry-after': '60' }, expected: new Date(now + 60_000).toISOString() },
    { headers: { 'retry-after': new Date(now + 120_000).toUTCString() }, expected: new Date(now + 120_000).toISOString() },
    { headers: { 'retry-after': 'invalid', 'x-ratelimit-reset': String((now + 180_000) / 1000) }, expected: new Date(now + 180_000).toISOString() },
    { headers: { 'x-ratelimit-reset': 'invalid' }, expected: 'after the service limit resets' }
  ];
  for (const { headers, expected } of cases) {
    const host = harness();
    host.state.accounts = [];
    host.state.respond = () => new Response('', { status: 429, headers });
    await assert.rejects(host.auth.credentials([repo('a')]), error => {
      assert.ok(String(error).includes(expected));
      return true;
    });
  }
});

test('authenticated rate limits, service errors and provider errors do not rotate or silently downgrade', async () => {
  for (const response of [
    () => new Response('', { status: 429 }),
    () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
  ]) {
    const host = harness();
    host.state.respond = (_url, headers) => headers.has('Authorization') ? response() : new Response('', { status: 404 });
    await assert.rejects(host.auth.credentials([repo('a')]), /rate limit.*selected account/i);
    assert.equal(host.requests.length, 2);
    assert.equal(host.requests[1].headers.get('Authorization'), 'Bearer token-one');
  }
  const unavailable = harness();
  unavailable.state.respond = () => new Response('', { status: 503 });
  await assert.rejects(unavailable.auth.credentials([repo('a')]), /unavailable/);
  assert.equal(unavailable.requests.length, 1);
  assert.equal(unavailable.calls.length, 0);
  const host = harness();
  host.state.providerError = new Error('Authentication provider unavailable');
  await assert.rejects(host.auth.credentials([repo('a')]), /provider unavailable/);
  assert.equal(host.requests.length, 1);
});

test('marketplace installation selects a verified account when anonymous GitHub quota is exhausted', async () => {
  await marketplaceFixture('org/a', async home => {
    const host = harness();
    host.state.respond = (_url, headers) => headers.has('Authorization') ? new Response('') :
      new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    const environment = await cliEnvironment(host.auth, ['install', 'agent-authoring@intelligentium'], home, home);
    assert.equal(environment.GITHUB_APM_PAT, 'token-one');
    assert.equal(host.requests.length, 2);
    assert.equal(host.requests[1].headers.get('Authorization'), 'Bearer token-one');
    assert.equal(host.auth.knownRepositories().length, 0);
  });
});

test('unverified or mixed-account installs still fail before the APM process starts', async () => {
  await marketplaceFixture('org/b', async home => {
    const host = harness();
    host.state.respond = (url, headers) => {
      const token = headers.get('Authorization');
      if (!token) return new Response('', { status: 429 });
      const expected = url.endsWith('/a') ? 'Bearer token-one' : 'Bearer token-two';
      return new Response('', { status: token === expected ? 200 : 404 });
    };
    const client = new ApmClient({ executable: join(home, 'must-not-start'), cwd: home, home,
      environment: (args, cwd, signal) => cliEnvironment(host.auth, args, cwd, home, signal) });
    await assert.rejects(client.execute(['install', 'agent-authoring@intelligentium']), /cannot safely route/);
    assert.equal(host.requests.length, 5);
  });
  await marketplaceFixture('org/a', async home => {
    const host = harness();
    host.state.accounts = [];
    host.state.respond = () => new Response('', { status: 429 });
    const client = new ApmClient({ executable: join(home, 'must-not-start'), cwd: home, home,
      environment: (args, cwd, signal) => cliEnvironment(host.auth, args, cwd, home, signal) });
    await assert.rejects(client.execute(['install', 'agent-authoring@intelligentium']), /rate limit.*anonymous/i);
    assert.equal(host.requests.length, 1);
  });
});

test('public access is first and missing files do not rotate authorized accounts', async () => {
  const host = harness();
  host.state.respond = (url, headers) => new Response('', { status: url.endsWith('/contents/missing') ? 404 : headers.has('Authorization') ? 200 : 401 });
  const response = await host.auth.fetch('https://api.github.com/repos/org/a/contents/missing', { headers: { Authorization: 'unsafe', Cookie: 'unsafe', Accept: 'application/json' } });
  assert.equal(response.status, 404);
  assert.equal(host.requests[0].headers.get('Authorization'), null);
  assert.equal(host.requests[0].headers.get('Cookie'), null);
  assert.equal(host.requests.at(-1)?.headers.get('Authorization'), 'Bearer token-one');
  assert.ok(host.requests.every(request => request.headers.get('Authorization') !== 'Bearer token-two'));
  assert.ok(host.requests.every(request => request.options.redirect === 'error' && request.options.credentials === 'omit'));
  const publicHost = harness();
  publicHost.state.respond = () => new Response('public');
  await publicHost.auth.fetch('https://api.github.com/repos/org/a');
  assert.equal(publicHost.calls.length, 0);
});

test('guards reject arbitrary URLs, methods, unapproved hosts and untrusted workspaces before credentials', async () => {
  const host = harness();
  for (const url of ['https://evil.test/repos/org/a', 'https://api.github.com/repos/org/a/issues',
    'https://user@api.github.com/repos/org/a', 'https://api.github.com/repos/org/a/../b',
    'https://api.github.com/repos/org/a/%2e%2e/b', 'https://api.github.com.evil.test/repos/org/a']) {
    await assert.rejects(host.auth.fetch(url), /approved repository/);
  }
  await assert.rejects(host.auth.fetch('https://api.github.com/repos/org/a', { method: 'POST' }), /read-only/);
  await assert.rejects(host.auth.credentials([{ ...repo('a'), origin: 'https://enterprise.test' }]), /approved repository/);
  assert.equal(host.requests.length, 0);
  host.state.trusted = false;
  await assert.rejects(host.auth.credentials([repo('a')]), /Trust this workspace/);
  await assert.rejects(host.auth.fetch('https://api.github.com/repos/org/a'), /Trust this workspace/);
  assert.equal(host.calls.length, 0);
});

test('cancellation and invalidation during session lookup prevent authenticated probes', async () => {
  for (const mode of ['abort', 'invalidate', 'dispose']) {
    const host = harness();
    let release!: () => void;
    host.state.sessionWait = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const operation = host.auth.credentials([repo('a')], controller.signal);
    while (!host.calls.length) await new Promise(resolve => setImmediate(resolve));
    if (mode === 'abort') controller.abort();
    else if (mode === 'invalidate') host.auth.invalidate();
    else host.auth.dispose();
    release();
    await assert.rejects(operation, /cancelled or changed/);
    assert.equal(host.requests.length, 1);
  }
});

test('enterprise Accounts are never requested for a different configured enterprise origin', async () => {
  const host = harness();
  host.state.picks.push('Approve repository host', 'github');
  host.state.inputs.push('https://enterprise.test');
  await host.auth.manage();
  host.state.enterprise = 'https://other-enterprise.test';
  assert.equal((await host.auth.credentials([{ ...repo('a'), origin: 'https://enterprise.test' }])).length, 0);
  assert.equal(host.calls.length, 0);
  host.state.enterprise = 'https://enterprise.test';
  host.state.respond = (_url, headers) => new Response('', { status: headers.has('Authorization') ? 200 : 404 });
  await host.auth.credentials([{ ...repo('a'), origin: 'https://enterprise.test' }]);
  assert.ok(host.calls.every(call => call.provider === 'github-enterprise'));
});

test('private enterprise metadata uses a repository-specific account without changing generation', async () => {
  const host = harness();
  host.state.picks.push('Approve repository host', 'github');
  host.state.inputs.push('https://enterprise.test');
  await host.auth.manage();
  host.state.enterprise = 'https://enterprise.test';
  const generation = host.auth.generation;
  let changes = 0;
  host.auth.onDidChange(() => { changes++; });
  host.state.respond = (url, headers) => {
    const repository = url.includes('/repos/org/a') ? 'a' : 'b';
    const expected = repository === 'a' ? 'Bearer token-one' : 'Bearer token-two';
    const authorized = headers.get('Authorization') === expected;
    return new Response(authorized ? `private-${repository}` : '', { status: authorized ? 200 : 404 });
  };
  const a = await host.auth.fetch('https://enterprise.test/api/v3/repos/org/a/contents/apm.yml');
  const b = await host.auth.fetch('https://enterprise.test/api/v3/repos/org/b/contents/apm.yml');
  assert.equal(await a.text(), 'private-a');
  assert.equal(await b.text(), 'private-b');
  assert.equal(host.auth.generation, generation);
  assert.equal(changes, 0);
  assert.ok(host.calls.every(call => call.provider === 'github-enterprise' && call.options.silent === true));
  const authenticatedFiles = host.requests.filter(request => request.url.includes('/contents/') && request.headers.has('Authorization'));
  assert.equal(authenticatedFiles.length, 2);
  assert.equal(authenticatedFiles[0].headers.get('Authorization'), 'Bearer token-one');
  assert.equal(authenticatedFiles[1].headers.get('Authorization'), 'Bearer token-two');
  assert.ok(host.requests.every(request => request.url.startsWith('https://enterprise.test/api/v3/repos/org/')));
  const credentials = await host.auth.credentials([
    { ...repo('a'), origin: 'https://enterprise.test' },
    { ...repo('b'), origin: 'https://enterprise.test' }
  ]);
  assert.deepEqual(Array.from(credentials, item => item.scheme), ['bearer', 'bearer']);
  assert.equal(host.auth.generation, generation);
});

test('repository PATs stay in SecretStorage, expire explicitly, and are deleted only by native management', async () => {
  const host = harness();
  const repository: Repository = { provider: 'gitlab', origin: 'https://gitlab.com', path: 'group/repo' };
  host.state.picks.push('Add repository token', 'Enter another repository...');
  host.state.inputs.push('https://gitlab.com/group/repo', 'private-pat');
  host.state.respond = (_url, headers) => new Response('', { status: headers.get('PRIVATE-TOKEN') === 'private-pat' ? 200 : 401 });
  await host.auth.manage();
  assert.equal(host.secrets.size, 1);
  assert.ok([...host.values.values()].every(value => !JSON.stringify(value).includes('private-pat')));
  assert.equal((await host.auth.credentials([repository]))[0].token, 'private-pat');
  host.state.respond = () => new Response('', { status: 401 });
  await assert.rejects(host.auth.credentials([repository]), /update its token/);
  host.secrets.clear();
  await assert.rejects(host.auth.credentials([repository]), /No authorized account/);
});

test('legacy environment does not choose an arbitrary account when several exist', async () => {
  const host = harness();
  assert.equal(Object.keys(await host.api.githubEnvironment()).length, 0);
  assert.equal(host.calls.length, 0);
});

test('unmanaged repositories without a usable account preserve CLI fallback but metadata stays explicit', async () => {
  const host = harness();
  host.state.accounts = [];
  assert.equal((await host.auth.credentials([repo('a')])).length, 0);
  await assert.rejects(host.auth.fetch('https://api.github.com/repos/org/a/contents/apm.yml'), /No authorized account/);
});

test('secret changes and management notify listeners without exposing credentials', async () => {
  const host = harness();
  let changes = 0;
  const listener = host.auth.onDidChange(() => { changes++; });
  const generation = host.auth.generation;
  host.state.picks.push('Add repository token', 'Enter another repository...');
  host.state.inputs.push('https://dev.azure.com/org/project/_git/repo', 'azure-pat');
  host.state.respond = (_url, headers) => new Response('', { status: headers.has('Authorization') ? 200 : 401 });
  await host.auth.manage();
  assert.ok(host.auth.generation > generation);
  assert.ok(changes >= 1);
  const credentials = await host.auth.credentials([{ provider: 'azure', origin: 'https://dev.azure.com', path: 'org/project/_git/repo' }]);
  assert.equal(credentials[0].scheme, 'basic');
  assert.equal(host.requests.at(-1)?.headers.get('Authorization'), `Basic ${Buffer.from('apm:azure-pat').toString('base64')}`);
  const count = changes;
  listener.dispose();
  host.auth.invalidate();
  assert.equal(changes, count);
});

test('SecretStorage errors propagate rather than pretending a token was saved', async () => {
  const host = harness();
  host.state.picks.push('Add repository token', 'Enter another repository...');
  host.state.inputs.push('https://gitlab.com/group/repo', 'private-pat');
  host.state.respond = () => new Response('');
  host.context.secrets.store = async () => { throw new Error('SecretStorage unavailable'); };
  await assert.rejects(host.auth.manage(), /SecretStorage unavailable/);
  assert.equal(host.auth.knownRepositories().length, 0);
});
