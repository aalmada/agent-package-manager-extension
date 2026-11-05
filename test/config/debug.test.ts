import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('workspace disables the experimental debug network view', () => {
  const settings = JSON.parse(readFileSync('.vscode/settings.json', 'utf8')) as Record<string, unknown>;
  assert.equal(settings['debug.javascript.enableNetworkView'], false);
});
