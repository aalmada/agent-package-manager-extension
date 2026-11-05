import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

test('Marketplace metadata identifies the public repository and uses a PNG icon', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    name: string; publisher: string; repository: { url: string }; icon: string;
  };
  assert.equal(`${manifest.publisher}.${manifest.name}`, 'antao-almada.apm-package-manager');
  assert.equal(manifest.repository.url, 'https://github.com/aalmada/agent-package-manager-extension.git');
  const icon = readFileSync(manifest.icon);
  assert.deepEqual(icon.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(icon.readUInt32BE(16), 256);
  assert.equal(icon.readUInt32BE(20), 256);
});

test('manual Marketplace publishing validates CI and publishes its VSIX with OIDC', () => {
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    on: Record<string, unknown>; jobs: { test: { env: { APM_CI_VERSION: string } } };
  };
  const contract = JSON.parse(readFileSync('src/apm/contract.json', 'utf8')) as { version: string };
  assert.ok(Object.hasOwn(ci.on, 'workflow_call'));
  assert.equal(ci.jobs.test.env.APM_CI_VERSION, contract.version);
  const workflow = parse(readFileSync('.github/workflows/publish.yml', 'utf8')) as {
    on: Record<string, unknown>;
    jobs: {
      validate: { needs: string; uses: string };
      publish: { needs: string; permissions: Record<string, string>; steps: { uses?: string; run?: string }[] };
    };
  };
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.jobs.validate.needs, 'validate-ref');
  assert.equal(workflow.jobs.validate.uses, './.github/workflows/ci.yml');
  assert.equal(workflow.jobs.publish.needs, 'validate');
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
  assert.ok(workflow.jobs.publish.steps.some(step => step.uses === 'actions/download-artifact@v4'));
  const publish = workflow.jobs.publish.steps.find(step => step.run?.includes('vsce publish'));
  assert.match(publish?.run ?? '', /vsce publish --oidc --packagePath/);
});
