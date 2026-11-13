// Renders the built webview with synthetic data to regenerate the documentation screenshots.
// Usage: npm run build && npm run docs:screenshots [-- --output <directory>]
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { descriptors } from '../src/apm/commands';
import { withInstallations } from '../src/apm/packageState';
import type { ActionResult } from '../src/apm/actions';
import type { PackageItem, Scope } from '../src/apm/types';
import type { State } from '../src/protocol';

const root = resolve(__dirname, '..');
const script = resolve(root, 'dist/webview.js'), styles = resolve(root, 'dist/webview.css');
const outputIndex = process.argv.indexOf('--output');
const output = resolve(root, outputIndex >= 0 && process.argv[outputIndex + 1] ? process.argv[outputIndex + 1] : 'docs/images');

const theme = `:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, Consolas, "Courier New", monospace;
  --vscode-foreground: #cccccc;
  --vscode-editor-background: #1f1f1f;
  --vscode-sideBar-background: #181818;
  --vscode-sideBarSectionHeader-background: #181818;
  --vscode-sideBarSectionHeader-foreground: #cccccc;
  --vscode-sideBarSectionHeader-border: #2b2b2b;
  --vscode-input-background: #313131;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-input-placeholderForeground: #989898;
  --vscode-focusBorder: #0078d4;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-button-border: #ffffff12;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-badge-background: #616161;
  --vscode-badge-foreground: #f8f8f8;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-icon-foreground: #cccccc;
  --vscode-textLink-foreground: #4daafc;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-errorForeground: #f85149;
  --vscode-widget-border: #313131;
  --vscode-panel-border: #2b2b2b;
  --vscode-textCodeBlock-background: #2b2b2b;
  --vscode-textBlockQuote-background: #2b2b2b;
  --vscode-textBlockQuote-border: #616161;
  --vscode-testing-iconPassed: #73c991;
  --vscode-charts-green: #89d185;
  --vscode-sash-hoverBorder: #0078d4;
}`;

const workspace: Scope = { kind: 'workspace', label: 'contoso-web', path: '/projects/contoso-web' };
const global: Scope = { kind: 'global', label: 'Global (user)', path: '/home/user/.apm' };
const marketplaces = [
  { name: 'contoso-agents', source: 'contoso/agent-plugins' },
  { name: 'team-skills', source: 'contoso/team-skills' }
];

function entry(marketplace: string, name: string, version: string, description: string): PackageItem {
  return { id: `${marketplace}::${name}`, name, marketplace, version, description, installed: false };
}
const catalogEntries = [
  entry('contoso-agents', 'code-review', '2.1.0', 'Review pull requests with focused agent workflows'),
  entry('team-skills', 'docs-writer', '1.4.0', 'Draft and refine technical documentation'),
  entry('contoso-agents', 'azure-diagnostics', '0.9.2', 'Diagnose cloud deployments with guided skills'),
  entry('team-skills', 'frontend-design', '1.3.0', 'Build accessible, polished interfaces'),
  entry('contoso-agents', 'test-generator', '3.0.1', 'Generate unit tests that follow project conventions'),
  entry('team-skills', 'release-notes', '1.0.0', 'Summarize merged changes into release notes')
];
const catalogItem = (name: string) => catalogEntries.find(item => item.name === name)!;
const installed: PackageItem[] = [
  { ...catalogItem('code-review'), version: '2.0.0', installed: true, scope: workspace, direct: true, updateStatus: 'outdated', latestVersion: '2.1.0' },
  { ...catalogItem('docs-writer'), installed: true, scope: workspace, direct: true, updateStatus: 'current' },
  { ...catalogItem('azure-diagnostics'), installed: true, scope: global, direct: true, updateStatus: 'current' },
  { id: 'contoso/agent-plugins/skills/markdown-lint', name: 'markdown-lint', marketplace: '', source: 'contoso/agent-plugins/skills/markdown-lint',
    version: '1.2.0', description: 'Lint Markdown before review', installed: true, scope: workspace, direct: false, updateStatus: 'current' }
];

function browserState(overrides: Partial<State> = {}): State {
  return {
    mode: 'browser', trusted: true, busy: false, errors: [], version: '0.35.0', projectPresent: true,
    scopes: [workspace, global], scopeKey: `workspace:${workspace.path}`,
    commands: descriptors, availableCommands: descriptors.map(descriptor => descriptor.id),
    marketplaces, checkedAt: '2026-05-01T10:00:00Z',
    catalog: withInstallations(catalogEntries, installed), installed,
    ...overrides
  };
}

const codeReview = installed[0];
const codeReviewDetails = {
  plugin: {
    name: 'code-review', version: '2.0.0', description: codeReview.description,
    keywords: ['code-review', 'pull-requests', 'quality'], author: 'Contoso Developer Experience', license: 'MIT'
  },
  contents: [
    { kind: 'skills', items: [
      { name: 'review-pull-request', description: 'Review a pull request for correctness, tests, and maintainability.' },
      { name: 'suggest-fixes', description: 'Propose minimal patches for review findings.' }
    ] },
    { kind: 'agents', items: [{ name: 'reviewer', description: 'Read-only reviewer that reports high-confidence issues.' }] },
    { kind: 'prompts', items: [{ name: 'review-checklist', description: 'Checklist used before approving a change.' }] }
  ]
};
const codeReviewReadme = `<h1>code-review</h1>
<p>Agent skills and a reviewer agent that help you review pull requests consistently.</p>
<h2>Usage</h2>
<p>Ask your coding agent to <em>review the current pull request</em>. The <code>review-pull-request</code> skill loads automatically.</p>
<h2>Requirements</h2>
<ul><li>A Git repository with an open pull request</li><li>A coding agent that supports skills</li></ul>`;

function detailsState(item: PackageItem, actionResult?: ActionResult, overrides: Partial<State> = {}): State {
  return browserState({
    mode: 'details', item, details: codeReviewDetails, readmeHtml: codeReviewReadme,
    ...(actionResult ? { actionResult } : {}), ...overrides
  });
}

const previewOutput = `[*] Validating 1 package...
[+] frontend-design@team-skills
[i] Dry run: Would add 1 package to apm.yml
[>] Previewing 1 package...
[i] Dry run mode - showing what would change:
[i] APM dependencies (1):
[i]   - frontend-design@team-skills -> install`;

const frontendDesign = catalogItem('frontend-design');
const frontendDetails = {
  plugin: { name: 'frontend-design', version: '1.3.0', description: frontendDesign.description, keywords: ['frontend', 'accessibility', 'design'], license: 'MIT' },
  contents: [{ kind: 'skills', items: [{ name: 'frontend-design', description: 'Design and build accessible user interfaces.' }] }]
};

// Page-side code is passed as strings because tsx injects helpers that do not exist in the page.
const post = (message: unknown) => `window.postMessage(${JSON.stringify(message)}, '*')`;
async function render(page: Page, state: State, search?: string, saved?: object) {
  await page.setContent('<main id="app"></main>');
  await page.addStyleTag({ content: theme });
  await page.addStyleTag({ path: styles });
  await page.addScriptTag({ content: `Object.defineProperty(window, 'acquireVsCodeApi', { value: () => ({ getState: () => (${JSON.stringify(saved ?? null)}) ?? undefined, setState: () => undefined, postMessage: () => undefined }) });` });
  await page.addScriptTag({ path: script });
  await page.evaluate(post({ type: 'state', state }));
  await page.waitForSelector(state.mode === 'browser' ? '#app.sidebar' : '#app.editor');
  if (search !== undefined) await page.evaluate(post({ type: 'setSearch', search }));
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

// `until` crops the capture just below the matching element.
interface Shot { file: string; width: number; height: number; state: State; search?: string; saved?: object; fullPage?: boolean; until?: string }
const shots: Shot[] = [
  { file: 'package-browser.png', width: 340, height: 820, state: browserState(), saved: { sizes: { catalog: 185, installed: 140, updates: 55 } } },
  { file: 'search-filters.png', width: 340, height: 360, state: browserState(), search: '@installed @scope:workspace' },
  { file: 'dependencies.png', width: 340, height: 480, state: browserState(), search: '@dependencies' },
  { file: 'initialize-project.png', width: 340, height: 300, search: '@installed',
    state: browserState({ projectPresent: false, installed: installed.filter(item => item.scope === global), catalog: withInstallations(catalogEntries, installed.filter(item => item.scope === global)) }) },
  { file: 'missing-cli.png', width: 340, height: 180, state: browserState({ version: undefined, error: 'APM CLI was not found.', errors: ['APM CLI was not found.'] }) },
  { file: 'package-details.png', width: 900, height: 900, fullPage: true, state: detailsState(codeReview) },
  { file: 'install-preview.png', width: 900, height: 560, until: '.action-result',
    state: detailsState(frontendDesign, {
      action: 'previewInstall', title: 'Preview install frontend-design', status: 'success', preview: true,
      command: 'apm install frontend-design@team-skills --dry-run', output: previewOutput,
      summary: 'Preview only. No package changes applied. Resolution may change before the real run; offline plans can be incomplete.'
    }, { details: frontendDetails, readmeHtml: '<h1>frontend-design</h1><p>Skills for building accessible, polished interfaces.</p>' }) },
  { file: 'package-audit.png', width: 900, height: 520, until: '.action-result',
    state: detailsState(codeReview, {
      action: 'audit', title: 'Audit code-review', status: 'failed', command: 'apm audit code-review@contoso-agents --format json',
      summary: 'Audit failed — 6 files scanned; 1 critical, 1 warning, 0 info.',
      audit: {
        passed: false, summary: { files_scanned: 6, files_affected: 2, critical: 1, warning: 1, info: 0 },
        coverage: { complete: true, primitives: [] },
        findings: [
          { severity: 'critical', file: '.github/skills/review-pull-request/SKILL.md', line: 14, column: 3, category: 'unicode',
            message: 'Hidden bidirectional control character', remediation: 'Remove the character or replace it with visible text.', navigationId: 'finding-1' },
          { severity: 'warning', file: '.github/prompts/review-checklist.prompt.md', line: 3, column: 1, category: 'unicode',
            message: 'Zero-width space', navigationId: 'finding-2' }
        ]
      }
    }) }
];

async function main() {
  if (!existsSync(script) || !existsSync(styles)) throw new Error('Built webview assets are missing. Run `npm run build` first.');
  mkdirSync(output, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const shot of shots) {
      const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 2, colorScheme: 'dark' });
      await render(page, shot.state, shot.search, shot.saved);
      const box = shot.until ? await page.locator(shot.until).boundingBox() : null;
      await page.screenshot({ path: resolve(output, shot.file), fullPage: !!box || (shot.fullPage ?? false),
        ...(box ? { clip: { x: 0, y: 0, width: shot.width, height: Math.ceil(box.y + box.height + 12) } } : {}) });
      await page.close();
      console.log(`Wrote ${resolve(output, shot.file)}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
