import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInstallation, selfUpdateCommand } from '../../src/apm/installation';

test('installation method is recognized from the CLI location', () => {
  assert.equal(classifyInstallation('/usr/local/lib/apm/apm', ['.apm-installed', '_internal', 'apm']), 'standalone');
  assert.equal(classifyInstallation('/opt/homebrew/Cellar/apm/0.35.0/libexec/apm', ['apm']), 'homebrew');
  assert.equal(classifyInstallation('/home/linuxbrew/.linuxbrew/Cellar/apm/0.35.0/bin/apm', []), 'homebrew');
  assert.equal(classifyInstallation('C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Microsoft.APM\\apm.exe', []), 'winget');
  assert.equal(classifyInstallation('/home/me/.local/share/pipx/venvs/apm-cli/bin/apm', ['python', 'apm']), 'pipx');
  assert.equal(classifyInstallation('/home/me/.venv/bin/apm', ['python3', 'pip', 'apm']), 'pip');
  assert.equal(classifyInstallation('/usr/bin/apm', ['ls', 'apm']), 'unknown');
});

test('self-update elevates root-owned bundles with both installer destinations', () => {
  const root = { method: 'standalone' as const, path: '/usr/local/lib/apm/apm', launcherDir: '/usr/local/bin', writable: false };
  assert.deepEqual(selfUpdateCommand('apm', root, 'darwin'),
    ['sudo', 'env', 'APM_INSTALL_DIR=/usr/local/bin', 'APM_LIB_DIR=/usr/local/lib/apm', 'sh', '-c', '"$0" self-update && chmod -R a+rX "$1"', '/usr/local/lib/apm/apm', '/usr/local/lib/apm']);
  assert.deepEqual(selfUpdateCommand('apm', { ...root, writable: true }, 'darwin'), ['apm', 'self-update']);
  assert.deepEqual(selfUpdateCommand('apm.exe', root, 'win32'), ['apm.exe', 'self-update']);
});
