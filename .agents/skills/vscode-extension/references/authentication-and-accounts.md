# Authentication and Accounts

## Choose the ownership model

| Need | Use |
| --- | --- |
| Access an existing GitHub or Microsoft account | `authentication.getSession` with the provider ID and least-privilege scopes. |
| Non-interactive lookup | `getSession(..., { silent: true })`; an unavailable or unauthorized session can return `undefined`. |
| Explicit sign-in | `getSession(..., { createIfNone: true })` from a user-invoked command. |
| Account selection or reauthentication | Supported session options such as `account`, `clearSessionPreference`, or `forceNewSession`; check minimum VS Code compatibility. |
| React to sign-in, sign-out, or token changes | `authentication.onDidChangeSessions`; filter by provider and refresh account-dependent state. |
| Store an extension-owned secret | `context.secrets`; do not copy provider-managed tokens into persistent storage. |
| Supply a new authentication service | `AuthenticationProvider`, `registerAuthenticationProvider`, and `contributes.authentication`. |

Consuming a built-in provider does not require registering another provider or duplicating its sign-in UI. Let VS Code handle account consent and session selection.

## Sign-in and account lifecycle

- Do not prompt for sign-in during activation, discovery, completion, or background refresh. Use silent lookup there; offer a focused sign-in action when a user requests a feature that needs authorization.
- Request only the scopes the feature needs. The example uses GitHub profile access; private repository access requires different permissions and explicit justification.
- Distinguish missing sessions, denied consent, provider errors, and service authorization failures. Do not catch them all and return an anonymous success-shaped fallback.
- Resolve the current session near the operation, not once at activation. Avoid persisting tokens or retaining stale sessions after account changes.
- Keep only necessary account identity in UI state. Never send access tokens, refresh tokens, or complete session objects to a webview.
- Apply Workspace Trust checks to workspace-code execution and credential injection. Account sign-in itself is not universally a workspace-trusted operation; gate it according to what the extension will authorize.
- `getSession` has no cancellation-token argument. After it resolves, recheck cancellation and captured operation scope before sending a request or starting a process.

### Example: silent lookup versus explicit sign-in

```ts
import * as vscode from 'vscode';

const providerId = 'github';
const scopes = ['read:user'];

async function existingSession(): Promise<vscode.AuthenticationSession | undefined> {
  return vscode.authentication.getSession(providerId, scopes, { silent: true });
}

async function signIn(): Promise<vscode.AuthenticationSession> {
  return vscode.authentication.getSession(providerId, scopes, { createIfNone: true });
}

function registerSignIn(
  context: vscode.ExtensionContext,
  updateAccount: (account: vscode.AuthenticationSessionAccountInformation) => Promise<void>,
  reportError: (error: unknown) => Promise<void>
): void {
  context.subscriptions.push(vscode.commands.registerCommand('sample.signIn', async () => {
    try {
      const session = await signIn();
      await updateAccount(session.account);
    } catch (error: unknown) {
      await reportError(error);
    }
  }));
}
```

Contribute the command to the manifest. Supply an error reporter that redacts details, records failures, and offers an actionable non-modal notification. Report sign-in success only after a session is returned; do not infer it from opening an Accounts UI.

### Example: refresh when sessions change

```ts
import * as vscode from 'vscode';

function registerAccountChanges(
  context: vscode.ExtensionContext,
  refreshAccount: () => Promise<void>,
  reportError: (error: unknown) => Promise<void>,
  output: vscode.OutputChannel
): void {
  context.subscriptions.push(vscode.authentication.onDidChangeSessions(event => {
    if (event.provider.id !== 'github') return;
    void refreshAccount().catch(reportError).catch(() => {
      output.appendLine('Failed to report an account refresh error.');
    });
  }));
}
```

Refresh with a silent session lookup and clear account-dependent UI when no session remains. Serialize or version refreshes so an older result cannot overwrite a newer account selection. Dispose the listener and clear in-memory credentials when the owning feature is disposed.

## Multiple accounts, disconnect, and sign-out

- Prefer the provider's built-in account picker. Where supported, `authentication.getAccounts` lists account identities, not credentials or proof of access; use `getSession` to authorize the selected account.
- Use `clearSessionPreference` only for an explicit account-switch action, not on each request. Use `forceNewSession` only for deliberate reauthentication; it can prompt even if a session exists.
- An extension-local **Disconnect** clears its own selection, caches, and owned secrets. It does not necessarily sign the user out of the provider or revoke a remote token.
- Consumers of a built-in provider do not own its sessions and have no general `authentication.removeSession` API. Direct provider-wide sign-out to VS Code Accounts; do not call private commands or delete another extension's secrets.
- A custom provider owns its `removeSession` implementation. Define whether it removes local credentials, revokes remote credentials, or both, and explain that behavior to users.

## Credential transport and fallback

- Attach tokens only to validated HTTPS destinations belonging to the intended service. Validate scheme, exact origin, and embedded credentials before obtaining or attaching a token.
- Reject redirects for credential-bearing requests unless every destination is explicitly validated. Use a scoped `Authorization` header, not query parameters, URL credentials, or browser cookies.
- Prefer a narrow request adapter over a global fetch wrapper. Do not accidentally overwrite unrelated authorization or forward credentials to arbitrary README images and links.
- For a trusted external executable that supports token injection, pass the token only in that child's environment. Never mutate global `process.env`, pass credentials in command-line arguments, or expose them in task definitions.
- Preserve an existing CLI authentication fallback when no VS Code session exists and the feature supports it. Never fall back silently after consent denial or provider failure.
- Redact injected tokens from stdout, stderr, errors, and streaming output, including tokens split across chunks. Avoid logging environment objects or session payloads.
- An authentication session does not guarantee service authorization. Handle permission failures and expired tokens explicitly; avoid automatic reauthentication loops.

## Custom provider checklist

- Declare the provider ID/label and register it with matching runtime identifiers; dispose the registration and owned listeners.
- Implement `getSessions`, `createSession`, `removeSession`, and `onDidChangeSessions`. Honor requested scopes and account options; emit accurate added/removed/changed events.
- Store owned secrets through `SecretStorage`; never return refresh tokens as an access token or embed credentials in account labels.
- Use an established OAuth implementation. Validate callback state and use PKCE where applicable; do not invent a credential exchange or use unsupported internal VS Code commands.
- Cover browser, remote, and desktop callback behavior only where supported. Verify APIs and provider features against `engines.vscode`.

## Test matrix

| Scenario | Expected behavior |
| --- | --- |
| No session during background refresh | No prompt; show signed-out state or documented CLI fallback. |
| Explicit sign-in, denied consent, or provider error | Success only with a returned session; cancellation/denial/error remains explicit. |
| Token change, sign-out, or account switch | Refresh silently; invalidate stale credentials and account-dependent data. |
| Cancellation while acquiring a session | No downstream request or process startup. |
| Unapproved origin or redirect | Reject before credential transmission. |
| Child process and streamed output | Scoped environment only; no token leakage, including split chunks. |
| Extension-local disconnect | Clear owned state without claiming provider-wide sign-out. |

Mock sessions with synthetic tokens and disposable account state. Do not use real accounts, modify the user's keychain, or alter global sign-in state in automated tests.

## Sources

- [Authentication API](https://code.visualstudio.com/api/references/vscode-api#authentication)
- [Session options](https://code.visualstudio.com/api/references/vscode-api#AuthenticationGetSessionOptions)
- [AuthenticationProvider](https://code.visualstudio.com/api/references/vscode-api#AuthenticationProvider)
- [Authentication contribution point](https://code.visualstudio.com/api/references/contribution-points#contributes.authentication)
- [Secret storage](https://code.visualstudio.com/api/extension-capabilities/common-capabilities#data-storage)
