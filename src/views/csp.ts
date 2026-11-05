export function contentSecurityPolicy(webviewSource: string, nonce: string, allowRemoteImages = false): string {
  return `default-src 'none'; img-src ${webviewSource} ${allowRemoteImages ? 'https: ' : ''}data:; style-src ${webviewSource}; script-src 'nonce-${nonce}';`;
}
