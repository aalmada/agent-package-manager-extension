# Webviews and Security

## Use a webview only when needed

Use a webview when the interaction genuinely needs custom HTML/CSS/JavaScript. Keep the extension host authoritative for filesystem access, authentication, process execution, and privileged actions.

### Webview checklist

- Set `enableScripts` only if scripts are required. Restrict local resources with `localResourceRoots` and convert extension resources with `webview.asWebviewUri`.
- Use a restrictive Content Security Policy with a per-render nonce for scripts. Avoid inline handlers, remote scripts, and broad `unsafe-*` directives.
- Validate every message on the host against a typed schema; reject unknown message types, malformed fields, and unauthorized actions.
- Treat webview data as untrusted. Render text by default; sanitize allowed rich content on the host and validate links before opening them.
- Keep remote images and external content blocked unless users explicitly opt in and the privacy implications are explained.
- Persist only necessary state with `getState`/`setState` or host storage. Handle disposal, visibility changes, cancellation, and repeated messages.
- Use theme variables; provide accessible labels, keyboard behavior, focus handling, contrast, and responsive layouts.

### Example: restrictive webview shell

This example runs in a Node.js extension host, not the browser-hosted extension runtime or the webview itself. Generate a fresh nonce for each document render. Add only the resource origins and capabilities the view needs.

```ts
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

function renderWebview(webview: vscode.Webview, scriptUri: vscode.Uri, styleUri: vscode.Uri): string {
  const nonce = randomBytes(18).toString('base64');
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <link rel="stylesheet" href="${styleUri}">
    <title>Report</title>
  </head>
  <body>
    <main id="app" aria-live="polite"></main>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
```

When building the webview, set `enableScripts` only if needed and restrict `localResourceRoots` to the required extension or workspace resource folders. Generate `scriptUri` and `styleUri` with `webview.asWebviewUri`.

For a web extension host, replace the Node import and nonce expression with Web Crypto:

```ts
const nonce = Array.from(
  globalThis.crypto.getRandomValues(new Uint8Array(18)),
  byte => byte.toString(16).padStart(2, '0')
).join('');
```

Neither approach belongs in the webview script: the host constructs the CSP and HTML. A web extension has a `browser` entry point and no Node filesystem or child-process access; access files through `workspace.fs`.

### Example: validate a host message

Define a narrow message schema and reject unknown requests before invoking privileged host operations.

```ts
type WebviewMessage = { type: 'refresh' } | { type: 'openReport'; id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMessage(value: unknown): WebviewMessage | undefined {
  if (!isRecord(value)) return;
  const message = value;

  if (message.type === 'refresh') return { type: 'refresh' };
  if (message.type === 'openReport' && typeof message.id === 'string') {
    return { type: 'openReport', id: message.id };
  }
}

function registerMessages(
  webview: import('vscode').Webview,
  output: import('vscode').OutputChannel,
  refresh: () => Promise<void>,
  openKnownReport: (id: string) => Promise<void>,
  reportError: (error: unknown) => Promise<void>
): import('vscode').Disposable {
  return webview.onDidReceiveMessage((value: unknown) => {
    const message = parseMessage(value);
    if (!message) {
      output.appendLine('Rejected an invalid webview message.');
      return;
    }
    const dispatch = async (): Promise<void> => {
      try {
        if (message.type === 'refresh') await refresh();
        else await openKnownReport(message.id);
      } catch (error: unknown) {
        await reportError(error);
      }
    };
    void dispatch().catch(() => {
      output.appendLine('Failed to report a webview operation error.');
    });
  });
}
```

Supply extension-owned handlers and a reporter that redacts diagnostic details, logs them, and offers an actionable error notification. Dispose the returned listener with its provider. Message validation does not replace authorization or resource checks: verify that the requested report exists and is available to this workspace before opening it.

## Host and workspace boundaries

- Declare the supported extension kind, Workspace Trust behavior, and virtual-workspace support accurately in the manifest.
- Check trust at each sensitive entry point, not just at activation. Avoid process execution, package installation, or workspace mutation from untrusted workspaces.
- Resolve files against the intended workspace folder, support multi-root explicitly, and contain paths before opening or modifying them. Do not trust decoded URIs or webview-provided file paths.
- Use VS Code authentication APIs or an existing credential provider. Never put tokens in settings, URLs, source files, fixtures, or logs; redact secrets from process output and errors.
- Pass external process arguments as an array, validate user input, set a deliberate working directory/environment, and report nonzero exits and launch failures explicitly.
- Make network access, installations, mutations, and script execution explicit. Discovery, completions, and activation should not unexpectedly run commands or make requests.
- Register event listeners, providers, output channels, and views for disposal. Honor cancellation tokens and do not leave background work or progress indicators running.

## Sources

- [Webview API guide](https://code.visualstudio.com/api/extension-guides/webview)
- [Webview UX guidelines](https://code.visualstudio.com/api/ux-guidelines/webviews)
- [Workspace Trust extension guide](https://code.visualstudio.com/api/extension-guides/workspace-trust)
- [VS Code Extension API](https://code.visualstudio.com/api/references/vscode-api)
- [Web Extensions](https://code.visualstudio.com/api/extension-guides/web-extensions)
