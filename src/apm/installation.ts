import { access, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export type InstallMethod = 'homebrew' | 'winget' | 'pipx' | 'pip' | 'standalone' | 'unknown';
/** `writable` is false when the CLI folder belongs to another account (for example root), so updating it needs elevation. */
export interface Installation { method: InstallMethod; path?: string; launcherDir?: string; writable: boolean }

/** Classifies how the APM CLI was installed from its resolved path and the files next to it. */
export function classifyInstallation(resolved: string, siblings: string[]): InstallMethod {
  const path = resolved.replace(/\\/g, '/');
  if (/\/Cellar\/|\/homebrew\/|\/linuxbrew\//i.test(path)) return 'homebrew';
  if (/\/WinGet\//i.test(path)) return 'winget';
  if (/\/pipx\//i.test(path)) return 'pipx';
  if (siblings.includes('.apm-installed') || siblings.includes('_internal')) return 'standalone';
  if (/\/site-packages\/|\/Python\d*\/Scripts\//i.test(path) || siblings.some(name => /^python(\d(\.\d+)?)?(\.exe)?$/i.test(name))) return 'pip';
  return 'unknown';
}

async function findOnPath(executable: string): Promise<string | undefined> {
  if (isAbsolute(executable)) return executable;
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, executable + extension);
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
    }
  }
  return undefined;
}

export async function detectInstallation(executable: string): Promise<Installation> {
  const found = await findOnPath(executable);
  if (!found) return { method: 'unknown', writable: false };
  const resolved = await realpath(found).catch(() => found);
  const siblings = await readdir(dirname(resolved)).catch(() => [] as string[]);
  const folder = dirname(resolved);
  const owned = typeof process.getuid !== 'function' || await stat(folder).then(info => info.uid === process.getuid!(), () => false);
  const writable = owned && await access(folder, constants.W_OK).then(() => true, () => false);
  return { method: classifyInstallation(resolved, siblings), path: resolved, launcherDir: dirname(found), writable };
}

/**
 * Command that updates a standalone install. APM's installer never elevates itself, and when it runs as root it
 * requires both destinations, so a root-owned bundle is updated in place with `sudo env APM_INSTALL_DIR=… APM_LIB_DIR=…`.
 */
export function selfUpdateCommand(executable: string, installation: Installation, os: string): string[] {
  if (installation.writable || !installation.path || os === 'win32') return [executable, 'self-update'];
  const bundle = dirname(installation.path), launcher = installation.launcherDir;
  const destinations = launcher && launcher !== bundle && /[\\/]apm$/.test(bundle) ? [`APM_INSTALL_DIR=${launcher}`, `APM_LIB_DIR=${bundle}`] : [];
  // The root-run installer creates the bundle as root-only (0700); restore read/execute access for everyone afterwards.
  return ['sudo', 'env', ...destinations, 'sh', '-c', '"$0" self-update && chmod -R a+rX "$1"', installation.path, bundle];
}
