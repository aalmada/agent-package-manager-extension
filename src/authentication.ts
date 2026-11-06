import * as vscode from 'vscode';

const scopes = ['repo'];

export async function githubEnvironment(): Promise<Record<string, string>> {
  const session = await vscode.authentication.getSession('github', scopes, { silent: true });
  return session ? { GITHUB_APM_PAT: session.accessToken } : {};
}

export async function signInToGithub(): Promise<void> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before signing in to GitHub for APM.');
  await vscode.authentication.getSession('github', scopes, { createIfNone: true });
}

export const githubFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'https:' || !['api.github.com', 'raw.githubusercontent.com'].includes(url.host) || url.username || url.password) {
    throw new Error('APM GitHub metadata requests must use an approved GitHub HTTPS host.');
  }
  const env = await githubEnvironment();
  const headers = new Headers(init?.headers);
  if (env.GITHUB_APM_PAT) headers.set('Authorization', `Bearer ${env.GITHUB_APM_PAT}`);
  return fetch(input, { ...init, headers, redirect: 'error', credentials: 'omit' });
};
