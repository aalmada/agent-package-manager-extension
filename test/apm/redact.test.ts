import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsUrlCredentials, redact, safePayload } from '../../src/apm/redact';

test('logs and nested metadata remove credentials before reaching UI', () => {
  for (const text of ['https://user:password@host/repo', 'Authorization: Bearer abc123secret', '{"access_token":"sensitive-value"}', 'GITHUB_APM_PAT=value123', 'github_pat_0123456789']) {
    const output = redact(text);
    for (const secret of ['password@', 'abc123secret', 'sensitive-value', 'value123', 'github_pat_0123456789']) assert.ok(!output.includes(secret), output);
  }
  assert.deepEqual(safePayload({ nested: { password: 'private-value' }, description: 'Public documentation' }), { nested: { password: '[redacted]' }, description: 'Public documentation' });
  assert.deepEqual(safePayload({ description: 'token=example-value', other: 'visible' }), { description: 'token=[redacted]', other: 'visible' });
});

test('URL redaction covers token-only HTTP userinfo and passwords without hiding SSH usernames', () => {
  for (const source of ['https://example-user@host.test/repo', 'HTTP://example-user@host.test/repo', 'https://part-one@part-two@host.test/repo', 'ssh://git:example-value@host.test/repo']) {
    assert.equal(containsUrlCredentials(source), true);
    assert.match(redact(source), /\/\/\[redacted\]@host\.test/);
  }
  for (const source of ['ssh://git@host.test/repo', 'git@host.test:org/repo', 'https://host.test/repo']) {
    assert.equal(containsUrlCredentials(source), false);
    assert.equal(redact(source), source);
  }
});
