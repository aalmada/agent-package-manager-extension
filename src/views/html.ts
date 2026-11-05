import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { contentSecurityPolicy } from './csp';

export function webviewHtml(webview: vscode.Webview, extension: vscode.Uri, allowRemoteImages = false): string {
  const nonce = randomBytes(18).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extension, 'dist', 'webview.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extension, 'dist', 'webview.css'));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(webview.cspSource, nonce, allowRemoteImages)}">
<link rel="stylesheet" href="${style}"><title>Agent Package Manager</title></head>
<body><main id="app" aria-live="polite"><p>Loading APM...</p></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
