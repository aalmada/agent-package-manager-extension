import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalog, parseInstalled, parseOutdated, parseTable, parseVariablePrompt } from '../../src/apm/adapters';

const catalog = `Plugins in 'test'
┏━━━━━━━━┳━━━━━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━━━━━┓
┃ Plugin ┃ Description ┃ Version ┃ Install     ┃
┡━━━━━━━━╇━━━━━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━━━━━┩
│ sample │ Review code │ 1.10.0  │ sample@test │
│ plain  │ --          │ --      │ plain@test  │
└────────┴─────────────┴─────────┴─────────────┘`;
test('catalog retains identity, marketplace and advertised version', () => {
  const rows = parseCatalog(catalog, 'test');
  assert.equal(rows[0].id, 'test::sample'); assert.equal(rows[0].version, '1.10.0');
  assert.equal(rows[1].version, 'Not specified');
  assert.throws(() => parseCatalog(catalog.replace('sample@test', 'sample@other'), 'test'), /Ambiguous/);
});
test('outdated separates unknown, incomparable, confirmed updates and current', () => {
  const text = `| Package | Current | Wanted | Latest | Status | Source |
| org/a | 1.0.0 | 1.2.0 | 2.0.0 | outdated | registry |
| org/b | main | - | - | unknown | git |
| org/c | 1.0.0 | - | 1.0.0 | up-to-date | git |
| org/d | local | - | - | not-comparable | local |`;
  const rows = parseOutdated(text);
  assert.deepEqual(rows.map(r => r.status), ['outdated', 'unknown', 'current', 'not-comparable']);
  assert.equal(rows[0].wanted, '1.2.0');
  assert.throws(() => parseOutdated(text.replace('outdated', 'invalid')), /Unrecognized/);
});
test('outdated accepts Rich ASCII header separators emitted by APM 0.35', () => {
  const text = `Dependency Status
+----------------------------------------------------------------------------------------+
| Package                | Current    | Latest     | Status       | Source               |
|------------------------+------------+------------+--------------+----------------------|
| github/awesome-copilot | main       | 96543145   | outdated     | git branch           |
+----------------------------------------------------------------------------------------+
[!] 1 outdated dependency found`;
  assert.deepEqual(parseOutdated(text), [{
    package: 'github/awesome-copilot', current: 'main', latest: '96543145',
    wanted: undefined, status: 'outdated', source: 'git branch'
  }]);
});
test('table adapters handle continuation rows and refuse truncated identities and malformed output', () => {
  assert.equal(parseTable('| Package | Current |\n| org/a | abc |\n| | def |', ['Package'])[0].Current, 'abcdef');
  assert.throws(() => parseTable('| Package | Current |\n| org/a | abc | extra |', ['Package']), /unexpected number of columns/);
  assert.throws(() => parseTable('| Package | Current |\n| org/… | abc |', ['Package']), /truncated/);
  assert.throws(() => parseOutdated('Connection failed'), /Unrecognized/);
  assert.deepEqual(parseOutdated('No locked dependencies found.'), []);
});
test('installed packages have version/source information and never start current', () => {
  const rows = parseInstalled('| Package | Version | Source | Skills |\n| org/pkg | 1.0.0 | github | 2 |');
  assert.equal(rows[0].updateStatus, 'unchecked'); assert.equal(rows[0].metadata?.Skills, '2');
  assert.deepEqual(parseInstalled('No dependencies installed.'), []);
  assert.deepEqual(parseInstalled('apm_modules/ directory exists but contains no valid packages (Project scope)'), []);
});

test('recognizes APM MCP variable prompts', () => {
  const header = '[>] Looking up 2 MCP servers in registry...\nEnvironment variables needed:\n';
  assert.deepEqual(parseVariablePrompt(header, '  CONTEXT7_API_KEY (API key for authentication): '),
    { name: 'CONTEXT7_API_KEY', description: 'API key for authentication', secret: true });
  assert.deepEqual(parseVariablePrompt(header, '  REGION: '), { name: 'REGION', description: '', secret: true });
  assert.deepEqual(parseVariablePrompt(header, '  DB_PASS (Database password): '),
    { name: 'DB_PASS', description: 'Database password', secret: true });
  assert.deepEqual(parseVariablePrompt(header, '  CREDENTIALS: '), { name: 'CREDENTIALS', description: '', secret: true });
  assert.equal(parseVariablePrompt('no header\n', '  CONTEXT7_API_KEY: '), undefined);
  assert.equal(parseVariablePrompt(header, '  [+] TOKEN: using existing value'), undefined);
});
