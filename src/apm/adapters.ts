import type { PackageItem, UpdateRow, UpdateStatus } from './types';

export function stripAnsi(text: string): string {
  // CSI escapes are emitted by some APM versions even when piped.
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}

export function parseTable(text: string, requiredHeaders: string[]): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  let headers: string[] | undefined;
  let current: Record<string, string> | undefined;
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^[│┃|]/.test(trimmed)) continue;
    if (/^\|[-+]+\|$/.test(trimmed)) continue;
    const cells = trimmed.split(/[│┃|]/).slice(1, -1).map(x => x.trim());
    if (!headers) {
      if (requiredHeaders.every(h => cells.includes(h))) headers = cells;
      continue;
    }
    if (cells.length !== headers.length) throw new Error('APM table has an unexpected number of columns.');
    if (cells[0]) {
      current = Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
      rows.push(current);
    } else if (current) {
      for (let i = 0; i < headers.length; i++) {
        if (cells[i]) current[headers[i]] += cells[i];
      }
    }
  }
  if (!headers) throw new Error(`Unrecognized APM output: missing ${requiredHeaders.join(', ')} table. See APM Output.`);
  for (const row of rows) {
    const identity = row[requiredHeaders[0]];
    if (!identity || /…|\.\.\./.test(identity)) throw new Error('APM truncated a package identity. Cannot safely use this output.');
  }
  return rows;
}

export function parseCatalog(text: string, marketplace: string): PackageItem[] {
  if (/has no plugins\b/i.test(stripAnsi(text))) return [];
  return parseTable(text, ['Plugin', 'Version', 'Install']).map(row => {
    if (row.Install !== `${row.Plugin}@${marketplace}`) throw new Error('Ambiguous or truncated APM catalog install expression.');
    return {
      id: `${marketplace}::${row.Plugin}`, name: row.Plugin, marketplace,
      version: row.Version === '--' || row.Version === '-' ? 'Not specified' : row.Version,
      description: row.Description === '--' ? '' : row.Description,
      installed: false, metadata: { ...row, installExpression: row.Install }
    };
  });
}

export function parseInstalled(text: string): PackageItem[] {
  const clean = stripAnsi(text);
  if (/no (?:apm )?(?:dependencies|packages) (?:installed|found)|no apm dependencies|no installed (?:apm )?(?:packages|dependencies)|apm_modules\/ directory exists but contains no valid packages/i.test(clean)) return [];
  return parseTable(clean, ['Package', 'Version', 'Source']).map(row => ({
    id: `installed::${row.Package}`, name: row.Package, marketplace: '',
    version: row.Version === '-' ? 'Not specified' : row.Version, installed: true,
    source: row.Source, updateStatus: 'unchecked', metadata: { ...row, cliIdentity: row.Package }
  }));
}

export function parseOutdated(text: string): UpdateRow[] {
  const clean = stripAnsi(text);
  if (/no (?:locked |remote |apm )?dependencies|no lockfile|nothing to check|no packages to check/i.test(clean)) return [];
  return parseTable(clean, ['Package', 'Current', 'Latest', 'Status']).map(row => {
    const states: Record<string, UpdateStatus> = {
      'up-to-date': 'current', 'outdated': 'outdated', 'unknown': 'unknown', 'not-comparable': 'not-comparable'
    };
    const status = states[row.Status];
    if (!status) throw new Error(`Unrecognized APM update state: ${row.Status}`);
    return { package: row.Package, current: row.Current, latest: row.Latest, wanted: row.Wanted, status, source: row.Source };
  });
}

export interface VariablePrompt { name: string; description: string; secret: true }

/** Recognizes APM's MCP environment-variable prompt, which is written without a trailing newline. */
export function parseVariablePrompt(output: string, pending: string): VariablePrompt | undefined {
  if (!/(?:Environment|Registry runtime) variables needed:/.test(stripAnsi(output))) return;
  const match = stripAnsi(pending).match(/^ {2}([A-Za-z_][A-Za-z0-9_]*)(?: \((.*)\))?: $/);
  if (!match) return;
  return { name: match[1], description: match[2] ?? '', secret: true };
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
