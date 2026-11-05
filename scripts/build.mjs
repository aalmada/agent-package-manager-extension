import { build, context } from 'esbuild';
import { mkdir, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

await mkdir('dist', { recursive: true });
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const licenses = await Promise.all(Object.entries(lock.packages).filter(([path, entry]) => path.startsWith('node_modules/') && !entry.dev).map(async ([path]) => {
  const metadata = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  const files = (await readdir(path)).filter(name => /^(licen[cs]e|copying)([.-].*)?$/i.test(name));
  if (!files.length) throw new Error(`Missing redistribution license for ${metadata.name}`);
  const text = await Promise.all(files.map(name => readFile(join(path, name), 'utf8')));
  return `${metadata.name}@${metadata.version}\n${'='.repeat(72)}\n${text.join('\n')}`;
}));
await writeFile('dist/THIRD_PARTY_LICENSES.txt', licenses.join('\n\n'));
const configs = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], sourcemap: true, target: 'node20' },
  { entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', bundle: true, platform: 'browser', format: 'iife', sourcemap: true, target: 'es2022' },
  { entryPoints: ['test/extension/suite.ts'], outfile: 'dist/test-suite.js', bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], target: 'node20' }
];
await copyFile('src/webview/styles.css', 'dist/webview.css');
if (process.argv.includes('--watch')) {
  for (const config of configs) await (await context(config)).watch();
  console.log('Watching TypeScript. Rebuild to copy CSS changes.');
} else {
  await Promise.all(configs.map(config => build(config)));
}
