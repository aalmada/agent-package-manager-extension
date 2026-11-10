import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { ApmClient } from '../../src/apm/client';

const source = buildSync({
  entryPoints: ['src/authentication.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode']
}).outputFiles[0].text;
const nodeRequire = createRequire(resolve('test/apm/authentication.test.ts'));
type Api = typeof import('../../src/authentication');

function harness() {
  const calls: { provider: string; scopes: string[]; options: { silent?: boolean; createIfNone?: boolean } }[] = [];
  const requests: { input: string | URL | Request; init?: RequestInit }[] = [];
  const state: { trusted: boolean; token?: string; error?: Error } = { trusted: true };
  const module = { exports: {} };
  runInNewContext(source, {
    module, exports: module.exports, URL, Headers,
    require: (id: string) => id === 'vscode' ? {
      EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
      workspace: { get isTrusted() { return state.trusted; } },
      authentication: {
        getSession: async (provider: string, scopes: string[], options: { silent?: boolean; createIfNone?: boolean }) => {
          calls.push({ provider, scopes, options });
          if (state.error) throw state.error;
          return state.token ? { accessToken: state.token } : undefined;
        }
      }
    } : nodeRequire(id),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response('metadata');
    }
  });
  return { api: module.exports as Api, state, calls, requests };
}

test('GitHub authentication uses VS Code Accounts silently until explicit sign-in requests repository access', async () => {
  const host = harness();
  assert.equal(Object.keys(await host.api.githubEnvironment()).length, 0);
  assert.equal(JSON.stringify(host.calls), '[{"provider":"github","scopes":["repo"],"options":{"silent":true}}]');
  host.state.token = 'opaque-account-credential';
  await host.api.signInToGithub();
  assert.equal(host.calls[1].options.createIfNone, true);
  assert.equal((await host.api.githubEnvironment()).GITHUB_APM_PAT, host.state.token);
  host.state.token = 'changed-account-credential';
  assert.equal((await host.api.githubEnvironment()).GITHUB_APM_PAT, host.state.token);
  delete host.state.token;
  assert.equal(Object.keys(await host.api.githubEnvironment()).length, 0);
  host.state.trusted = false;
  const count = host.calls.length;
  await assert.rejects(host.api.signInToGithub(), /Trust this workspace/);
  assert.equal(host.calls.length, count);
});

test('account authorization failures remain explicit and prevent process startup', async () => {
  const host = harness();
  host.state.error = new Error('Account authorization denied');
  await assert.rejects(host.api.signInToGithub(), /Account authorization denied/);
  const client = new ApmClient({ executable: '/missing-apm', cwd: process.cwd(), environment: host.api.githubEnvironment });
  await assert.rejects(client.execute(['marketplace', 'add', 'owner/private']), /Account authorization denied/);
});

test('Accounts tokens reach only child environments and are masked in captured and streamed output', async () => {
  const host = harness();
  host.state.token = 'opaque-account-credential';
  const inherited = process.env.GITHUB_APM_PAT;
  const output: string[] = [];
  const client = new ApmClient({ executable: process.execPath, cwd: process.cwd(),
    environment: host.api.githubEnvironment, onOutput: text => output.push(text) });
  const result = await client.execute(['-e',
    'const t=process.env.GITHUB_APM_PAT;process.stdout.write(t.slice(0,8));setTimeout(()=>{console.log(t.slice(8));console.error(t)},10)']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), '[redacted]');
  assert.equal(result.stderr.trim(), '[redacted]');
  assert.ok(output.length > 0);
  assert.ok(output.every(text => !text.includes(host.state.token!) && !text.includes('opaque')));
  assert.equal(process.env.GITHUB_APM_PAT, inherited);
});

test('cancellation while retrieving account credentials prevents process startup', async () => {
  const controller = new AbortController();
  const client = new ApmClient({ executable: '/missing-apm', cwd: process.cwd(),
    environment: async () => { controller.abort(); return {}; } });
  await assert.rejects(client.execute([], { signal: controller.signal }), /cancelled/);
});

test('public GitHub metadata stays anonymous on approved repository HTTPS routes and refuses redirects', async () => {
  const host = harness();
  host.state.token = 'opaque-account-credential';
  await host.api.githubFetch('https://raw.githubusercontent.com/owner/private/main/README.md', { headers: { Accept: 'text/plain' } });
  const init = host.requests[0].init!;
  const headers = new Headers(init.headers);
  assert.equal(headers.get('Authorization'), null);
  assert.equal(headers.get('Accept'), 'text/plain');
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  await host.api.githubFetch(new URL('https://api.github.com/repos/owner/private/git/trees/HEAD'));
  delete host.state.token;
  await host.api.githubFetch('https://api.github.com/repos/owner/public');
  assert.equal(new Headers(host.requests[2].init?.headers).get('Authorization'), null);
  for (const url of ['http://api.github.com/repos/owner/private', 'https://github.com.evil.test/file',
    'https://example.test/marketplace.json', 'https://user@api.github.com/repos/owner/private']) {
    await assert.rejects(host.api.githubFetch(url), /approved repository HTTPS URL/);
  }
  assert.equal(host.requests.length, 3);
});
