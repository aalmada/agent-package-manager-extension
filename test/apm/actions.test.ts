import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageIdentity, packageUpdateCommand, parseAudit, parseTargets, parseVersions, tail, verifyPackageUpdate, versionSource, withRef, type ActionResult } from '../../src/apm/actions';
import type { PackageItem } from '../../src/apm/types';
import { parseMessage } from '../../src/protocol';
import { olderThan } from '../../src/apm/client';

const catalog: PackageItem = {
  id: 'awesome-copilot::accessibility-kanban', name: 'accessibility-kanban', marketplace: 'awesome-copilot', version: '1.0.2', installed: false,
  metadata: { installExpression: 'accessibility-kanban@awesome-copilot', plugin: { name: 'accessibility-kanban', source: 'plugins/accessibility-kanban' } }
};
const installed: PackageItem = {
  ...catalog, installed: true,
  metadata: { cliIdentity: 'github/awesome-copilot/plugins/accessibility-kanban', installExpression: 'accessibility-kanban@awesome-copilot' }
};

test('package identity uses marketplace notation to install and the CLI identity otherwise', () => {
  assert.equal(packageIdentity(catalog, undefined, true), 'accessibility-kanban@awesome-copilot');
  assert.equal(packageIdentity(catalog, installed, false), 'github/awesome-copilot/plugins/accessibility-kanban');
  assert.equal(packageIdentity({ ...catalog, metadata: {} }, undefined, false), 'accessibility-kanban@awesome-copilot');
  assert.equal(packageIdentity({ id: 'installed::org/repo', name: 'org/repo', marketplace: '', version: '1', installed: true, metadata: { lockIdentity: 'org/repo' } }, undefined, false), 'org/repo');
});

test('version source resolves the repository behind a marketplace plugin', () => {
  const marketplaces = [{ name: 'awesome-copilot', source: 'github/awesome-copilot' }];
  assert.equal(versionSource(catalog, undefined, marketplaces), 'github/awesome-copilot');
  assert.equal(versionSource({ ...catalog, metadata: { plugin: { source: { source: 'github', repo: 'org/plugin' } } } }, undefined, marketplaces), 'org/plugin');
  assert.equal(versionSource(catalog, installed, marketplaces), 'github/awesome-copilot/plugins/accessibility-kanban');
  assert.equal(versionSource(catalog, undefined, []), 'accessibility-kanban@awesome-copilot');
});

test('updating a tagged package installs the advertised release instead of refreshing its old pin', () => {
  const tagged = { ...installed, latestVersion: 'dotnet-v0.8.0', metadata: {
    cliIdentity: 'netfabric/intelligentium/plugins/dotnet', update: { source: 'git tags' }
  } };
  assert.deepEqual(packageUpdateCommand(tagged), { id: 'install', packages: 'netfabric/intelligentium/plugins/dotnet#dotnet-v0.8.0' });
  assert.deepEqual(packageUpdateCommand(installed), { id: 'update', packages: 'github/awesome-copilot/plugins/accessibility-kanban' });
  assert.throws(() => packageUpdateCommand({ ...tagged, latestVersion: '-' }), /usable latest tag/);
  assert.throws(() => packageUpdateCommand({ ...tagged, latestVersion: 'dotnet-v0.…' }), /usable latest tag/);
  assert.throws(() => packageUpdateCommand({ ...tagged, latestVersion: '--force' }), /begin with/);
  assert.throws(() => packageUpdateCommand({ ...tagged, direct: false }), /parent dependency/);
});

test('a zero-exit update is successful only when the refreshed package is current', () => {
  const result: ActionResult = { action: 'update', title: 'Update dotnet', status: 'success', command: 'apm update dotnet', output: 'All dependencies already at their latest matching refs.' };
  assert.equal(verifyPackageUpdate(result, { ...installed, updateStatus: 'current' }).status, 'success');
  const noop = verifyPackageUpdate(result, { ...installed, updateStatus: 'outdated', latestVersion: 'dotnet-v0.8.0' });
  assert.equal(noop.status, 'failed');
  assert.match(noop.summary ?? '', /still has an update available: dotnet-v0\.8\.0/);
  assert.equal(noop.output, result.output);
  for (const updateStatus of ['unknown', 'failed', 'unchecked'] as const) {
    assert.equal(verifyPackageUpdate(result, { ...installed, updateStatus }).status, 'failed');
  }
  assert.equal(verifyPackageUpdate(result, { ...installed, updateStatus: 'current', updateStale: true }).status, 'failed');
  assert.equal(verifyPackageUpdate(result, undefined).status, 'failed');
  assert.match(verifyPackageUpdate(result, installed, 'Refresh failed').summary ?? '', /Refresh failed/);
  const failed = { ...result, status: 'failed' as const };
  assert.equal(verifyPackageUpdate(failed, installed), failed);
});

test('refs are appended safely', () => {
  assert.equal(withRef('code-review@acme#v1', 'v2.0.0'), 'code-review@acme#v2.0.0');
  assert.equal(withRef('org/repo', ' '), 'org/repo');
  assert.throws(() => withRef('org/repo', '--force'));
  assert.throws(() => withRef('org/repo', 'a b'));
});

test('versions table output is parsed', () => {
  const output = [
    '          Available versions: microsoft/apm-sample-package           ',
    '┏━━━━━━━━━━━━━━━┳━━━━━━━━┳━━━━━━━━━━┓',
    '┃ Name          ┃ Type   ┃ Commit   ┃',
    '┡━━━━━━━━━━━━━━━╇━━━━━━━━╇━━━━━━━━━━┩',
    '│ v1.0.0        │ tag    │ fb285168 │',
    '│ feat/hooks    │ branch │ 9cfa8dad │',
    '└───────────────┴────────┴──────────┘'
  ].join('\n');
  assert.deepEqual(parseVersions(output), [{ name: 'v1.0.0', type: 'tag', commit: 'fb285168' }, { name: 'feat/hooks', type: 'branch', commit: '9cfa8dad' }]);
  assert.deepEqual(parseVersions('╭── Plugin: x (marketplace: m) ──╮\n│ Name:    x │\n│ Version: 1 │\n╰──╯'), []);
});

test('audit JSON summaries and findings are parsed', () => {
  const report = parseAudit('{"version":"1","passed":false,"exit_code":1,"summary":{"files_scanned":3,"files_affected":1,"critical":1,"warning":0,"info":0},"findings":[{"severity":"critical","file":".github/x.md","message":"Hidden Unicode"}]}');
  assert.equal(report?.passed, false);
  assert.equal(report?.summary.critical, 1);
  assert.deepEqual(report?.findings, [{ severity: 'critical', file: '.github/x.md', message: 'Hidden Unicode' }]);
  assert.equal(parseAudit('not json'), undefined);
});

test('targets are parsed from install help without matching --runtime prose', () => {
  const help = `  --runtime TEXT                  Target a specific runtime only. Values:
                                  claude, codex. (legacy alias for --target, single value
                                  only; prefer --target)
  -t, --target TARGET             Target harness(es) to deploy to. Values: agent-skills, all,
                                  copilot-app, vscode.
                                  More prose.
  --allow-insecure                Allow http`;
  assert.deepEqual(parseTargets(help), ['agent-skills', 'all', 'copilot-app', 'vscode']);
  assert.deepEqual(parseTargets('Usage: apm install'), []);
});

test('audit preserves incomplete coverage and physical versus decoded finding coordinates', () => {
  const coverage = {
    complete: false,
    primitives: [{ file: '.github/hooks.json', target: 'copilot', kind: 'hooks', pointer: '/hooks/0', tracked: true, strippable: false, status: 'incomplete', diagnostic: 'Prompt format could not be inspected.' }]
  };
  const report = parseAudit(JSON.stringify({
    passed: false, exit_code: 1, summary: { files_scanned: 0 }, coverage,
    findings: [
      { severity: 'critical', file: 'a.md', line: 2, column: 3, category: 'unicode', description: 'Hidden character', remediation: 'Review source.' },
      { severity: 'warning', file: '.github/hooks.json', pointer: '/hooks/0', decoded_line: 4, decoded_column: 5, description: 'Decoded prompt warning' }
    ]
  }))!;
  assert.equal(report.passed, false);
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.coverage, coverage);
  assert.deepEqual(report.findings[0], { severity: 'critical', file: 'a.md', line: 2, column: 3, category: 'unicode', message: 'Hidden character', remediation: 'Review source.' });
  assert.deepEqual(report.findings[1], { severity: 'warning', file: '.github/hooks.json', pointer: '/hooks/0', decodedLine: 4, decodedColumn: 5, message: 'Decoded prompt warning' });
  assert.equal(parseAudit(JSON.stringify({ passed: true, coverage }))?.passed, false);
  assert.equal(parseAudit(JSON.stringify({ passed: true, exit_code: 1 }))?.passed, false);
  assert.equal(parseAudit(JSON.stringify({ passed: true, coverage: { ...coverage, complete: true } }))?.coverage?.complete, false);
  assert.equal(parseAudit(JSON.stringify({ passed: true, coverage: { complete: true, primitives: [] } }))?.passed, true);
  assert.throws(() => parseAudit('{"coverage":{"complete":false}}'), /Unrecognized APM audit coverage/);
  assert.throws(() => parseAudit('{"coverage":{"complete":true,"primitives":[null]}}'), /Unrecognized APM audit coverage entry/);
});

test('long output keeps its tail', () => {
  assert.equal(tail('abc', 10), 'abc');
  assert.match(tail('x'.repeat(20) + 'END', 5), /truncated[\s\S]*xxEND$/);
});

test('package action messages are validated', () => {
  assert.deepEqual(parseMessage({ type: 'packageAction', action: 'audit' }), { type: 'packageAction', action: 'audit' });
  assert.throws(() => parseMessage({ type: 'packageAction', action: 'rm -rf' }));
  assert.throws(() => parseMessage({ type: 'packageAction' }));
});

test('only older APM versions are flagged as out of date', () => {
  assert.equal(olderThan('0.28.0', '0.35.0'), true);
  assert.equal(olderThan('0.35.0', '0.35.0'), false);
  assert.equal(olderThan('0.36.1', '0.35.0'), false);
  assert.equal(olderThan('0.35.0-rc1', '0.35.0'), false);
  assert.equal(olderThan('1.0.0', '0.35.0'), false);
});
