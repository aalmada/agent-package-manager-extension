function maskUrlCredentials(text: string, onMatch?: () => void): string {
  const mask = (_match: string, scheme: string) => {
    onMatch?.();
    return `${scheme}[redacted]@`;
  };
  return text.replace(/(https?:\/\/)[^\s/?#"'<>]+@/gi, mask)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'<>]*:[^\s/?#"'<>]*@/gi, mask);
}

export function containsUrlCredentials(text: string): boolean {
  let found = false;
  maskUrlCredentials(text, () => { found = true; });
  return found;
}

export function redact(text: string): string {
  let result = maskUrlCredentials(text)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]')
    .replace(/(authorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s"'<>;,]+/gi, '$1[redacted]')
    .replace(/((?:token|password|secret|_PAT)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(["'][^"']*(?:token|password|secret|authorization)["']\s*:\s*["'])[^"']*(["'])/gi, '$1[redacted]$2');
  for (const [name, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|(?:^|_)PAT$/.test(name) && value && value.length >= 6) result = result.split(value).join('[redacted]');
  }
  return result;
}

export function safePayload(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, entry: unknown) =>
    /token|password|secret|authorization|private.?key|credential/i.test(key) && typeof entry === 'string' ? '[redacted]' :
      typeof entry === 'string' ? redact(entry) : entry));
}
