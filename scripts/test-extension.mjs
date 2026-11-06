import { runTests, downloadAndUnzipVSCode } from '@vscode/test-electron';
import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

let vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH ?? await downloadAndUnzipVSCode();
// Newer macOS builds use "Code" instead of the legacy Electron bundle executable.
if (process.platform === 'darwin' && !existsSync(vscodeExecutablePath)) vscodeExecutablePath = join(dirname(vscodeExecutablePath), 'Code');

const home = await mkdtemp(join(tmpdir(), 'apm-extension-host-'));
const userData = join(home, 'user-data');
try {
  // Pre-existing CLI state that the extension must import into settings on startup.
  const seeded = join(home, 'markets', 'seeded');
  const legacy = join(home, 'markets', 'legacy');
  const project = join(home, 'project');
  await mkdir(seeded, { recursive: true });
  await mkdir(legacy, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(join(home, '.apm'), { recursive: true });
  await writeFile(join(seeded, 'marketplace.json'), JSON.stringify({ name: 'seeded', plugins: [] }));
  await writeFile(join(legacy, 'marketplace.json'), JSON.stringify({ name: 'legacy', plugins: [] }));
  await writeFile(join(home, '.apm', 'marketplaces.json'), JSON.stringify({ marketplaces: [{ name: 'seeded', url: seeded }] }));
  await writeFile(join(home, '.apm', 'config.json'), JSON.stringify({ auto_integrate: false, prefer_ssh: false }));
  await mkdir(join(userData, 'User'), { recursive: true });
  await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({
    'chat.disableAIFeatures': true, 'window.restoreWindows': 'none',
    'workbench.enableExperiments': false, 'telemetry.telemetryLevel': 'off',
    'task.autoDetect': 'on',
    'apm.executablePath': process.env.APM_TEST_EXECUTABLE ?? 'apm',
    'apm.marketplaceEntries': [{ source: legacy, name: 'legacy-alias' }],
    'apm.config.preferSsh': true
  }));
  // The extension activates on startup and syncs ~/.apm, so HOME must be isolated before VS Code starts.
  await runTests({
    extensionDevelopmentPath: resolve('.'),
    extensionTestsPath: resolve('dist/test-suite.js'),
    vscodeExecutablePath,
    extensionTestsEnv: {
      APM_TEST_HOME: home, APM_TEST_EXECUTABLE: process.env.APM_TEST_EXECUTABLE ?? 'apm',
      HOME: home, USERPROFILE: home, APM_CACHE_DIR: join(home, 'cache'),
      XDG_CACHE_HOME: join(home, '.cache'), XDG_CONFIG_HOME: join(home, '.config'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'), COPILOT_HOME: join(home, '.copilot')
    },
    launchArgs: ['--use-inmemory-secretstorage', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
      '--user-data-dir', userData, '--extensions-dir', join(home, 'extensions'), project]
  });
} catch (error) {
  try {
    const logs = join(userData, 'logs');
    for (const file of await readdir(logs, { recursive: true, withFileTypes: true })) {
      if (file.isFile() && /(?:^|-)APM\.log$/.test(file.name)) {
        console.error(`[APM output: ${file.name}]\n${(await readFile(join(file.parentPath, file.name), 'utf8')).slice(-16_000)}`);
      }
    }
  } catch (diagnosticError) { console.error('Could not read isolated APM output logs:', diagnosticError); }
  throw error;
} finally { await rm(home, { recursive: true }); }
