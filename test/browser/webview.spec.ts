import { test, expect } from '@playwright/test';
import { descriptors } from '../../src/apm/commands';
import type { State } from '../../src/protocol';

for (const theme of ['dark', 'light', 'high-contrast']) {
  test(`sidebar is functional at a narrow width in ${theme}`, async ({ page }, testInfo) => {
    const dark = theme !== 'light';
    await page.setViewportSize({ width: 340, height: 900 });
    await page.setContent('<main id="app"></main>');
    await page.addStyleTag({ content: `:root {
      --vscode-font-family: Arial, sans-serif; --vscode-font-size:13px;
      --vscode-foreground:${dark ? '#ddd' : '#222'};
      --vscode-editor-background:${dark ? '#1e1e1e' : '#fff'};
      --vscode-sideBar-background:${dark ? '#181818' : '#f3f3f3'};
      --vscode-input-background:${dark ? '#252526' : '#fff'};
      --vscode-input-foreground:${dark ? '#ddd' : '#222'};
      --vscode-input-border:${theme === 'high-contrast' ? '#fff' : '#454545'};
      --vscode-button-background:#0078d4; --vscode-button-foreground:white;
      --vscode-button-hoverBackground:#026ec1; --vscode-descriptionForeground:${dark ? '#aaa' : '#555'};
      --vscode-badge-background:#444; --vscode-badge-foreground:white;
      --vscode-focusBorder:#0078d4; --vscode-editorWarning-foreground:#cca700;
      --vscode-list-hoverBackground:${dark ? '#2b2d2e' : '#e5e5e5'};
      --vscode-icon-foreground:${dark ? '#ccc' : '#333'};
      --vscode-menu-background:${dark ? '#252526' : '#fff'};
      --vscode-menu-foreground:${dark ? '#ddd' : '#222'};
    }` });
    await page.addStyleTag({ path: 'dist/webview.css' });
    await page.evaluate(() => {
      Object.defineProperty(window, 'acquireVsCodeApi', { value: () => ({ getState: () => undefined, setState: () => {}, postMessage: (message: unknown) => {
        document.documentElement.dataset.lastMessage = JSON.stringify(message);
      } }) });
    });
    await page.addScriptTag({ path: 'dist/webview.js' });
    const state: State = {
      mode: 'browser', trusted: true, busy: false, errors: [], version: '0.35.0',
      scopes: [{ kind: 'workspace', label: 'My agent project', path: '/project' }, { kind: 'global', label: 'Global (user)', path: '/home/user/.apm' }],
      scopeKey: 'workspace:/project', commands: descriptors, availableCommands: ['install', 'marketplace'],
      marketplaces: [{ name: 'copilot-plugins', source: 'github/copilot-plugins' }, { name: 'team-skills', source: 'example/team-skills' }],
      checkedAt: '2026-11-05T10:00:00Z',
      catalog: [
        { id: 'copilot-plugins::code-review', name: 'code-review', marketplace: 'copilot-plugins', description: 'Review code with focused agent workflows', version: '2.1.0', installed: true, updateStatus: 'outdated' },
        { id: 'team-skills::frontend-design', name: 'frontend-design', marketplace: 'team-skills', description: 'Build accessible, polished interfaces', version: '1.3.0', installed: false }
      ],
      installed: [{ id: 'copilot-plugins::code-review', name: 'code-review', marketplace: 'copilot-plugins', description: 'Review code with focused agent workflows', version: '2.0.0', installed: true, updateStatus: 'outdated' }]
    };
    await page.evaluate(value => window.postMessage({ type: 'state', state: value }, '*'), state);
    await expect(page.locator('.package-row')).toHaveCount(4);
    await expect(page.locator('.badge.warning')).toHaveCount(2);
    await expect(page.locator('.package-section').nth(2).locator('.badge.warning')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`sidebar-${theme}.png`), fullPage: true });
    await page.evaluate(() => document.addEventListener('contextmenu', event => { document.documentElement.dataset.contextMenu = (event.target as HTMLElement).dataset.vscodeContext ?? ''; }));
    await page.getByLabel('Filter and sort packages').click();
    await expect(page.locator('html')).toHaveAttribute('data-context-menu', /"webviewSection":"filter"/);
    await page.evaluate(() => window.postMessage({ type: 'setSearch', search: '@marketplace:team-skills' }, '*'));
    await expect(page.locator('.package-row')).toHaveCount(1);
    await page.getByRole('button', { name: 'Clear search and filters' }).click();
    await expect(page.locator('.package-row')).toHaveCount(4);
    await page.locator('.package-row').first().click();
    await expect(page.locator('html')).toHaveAttribute('data-last-message', '{"type":"details","id":"copilot-plugins::code-review"}');
  });

  test(`plugin details show readable metadata at a narrow width in ${theme}`, async ({ page }, testInfo) => {
    const dark = theme !== 'light';
    await page.setViewportSize({ width: 420, height: 900 });
    await page.setContent('<main id="app"></main>');
    await page.addStyleTag({ content: `:root {
      --vscode-font-family: Arial, sans-serif; --vscode-font-size:13px;
      --vscode-foreground:${dark ? '#ddd' : '#222'};
      --vscode-editor-background:${dark ? '#1e1e1e' : '#fff'};
      --vscode-sideBar-background:${dark ? '#181818' : '#f3f3f3'};
      --vscode-input-border:${theme === 'high-contrast' ? '#fff' : '#808080'};
      --vscode-button-background:#0078d4; --vscode-button-foreground:white;
      --vscode-button-hoverBackground:#026ec1; --vscode-descriptionForeground:${dark ? '#aaa' : '#555'};
      --vscode-badge-background:${dark ? '#444' : '#d6d6d6'}; --vscode-badge-foreground:${dark ? '#fff' : '#111'};
      --vscode-focusBorder:#0078d4; --vscode-textLink-foreground:#3794ff;
    }` });
    await page.addStyleTag({ path: 'dist/webview.css' });
    await page.evaluate(() => {
      Object.defineProperty(window, 'acquireVsCodeApi', { value: () => ({ getState: () => undefined, setState: () => {}, postMessage: (message: unknown) => {
        document.documentElement.dataset.lastMessage = JSON.stringify(message);
      } }) });
    });
    await page.addScriptTag({ path: 'dist/webview.js' });
    const item = {
      id: 'awesome-copilot::azure-cost-health-check', name: 'azure-cost-health-check', marketplace: 'awesome-copilot',
      description: 'Read-only Azure cost, forecasts and budget alerts.', version: '0.4.5', installed: false
    };
    const state: State = {
      mode: 'details', trusted: true, busy: false, errors: [], version: '0.35.0',
      scopes: [{ kind: 'workspace', label: 'My project', path: '/project' }], scopeKey: 'workspace:/project',
      commands: descriptors, availableCommands: ['install', 'view'], catalog: [item], installed: [], marketplaces: [], item,
      details: {
        plugin: { author: { name: 'Example author', url: 'https://example.com/author' }, license: 'MIT',
          keywords: ['azure', 'cost-management', 'monitoring'], source: { source: 'github', repo: 'microsoft/azure-dev-tools' } },
        contents: [
          { kind: 'skills', items: [{ name: 'azure-cost-health-check', description: 'Review Azure costs and forecasts.', path: 'skills/azure-cost-health-check/SKILL.md' }] },
          { kind: 'agents', items: [{ name: 'reviewer', path: 'agents/reviewer.agent.md' }] }
        ],
        rawOutput: '{"hidden":true}'
      },
      readmeHtml: '<h2>Overview</h2><p>Package documentation.</p>'
    };
    await page.evaluate(value => window.postMessage({ type: 'state', state: value }, '*'), state);
    await expect(page.locator('.detail-tag')).toHaveCount(3);
    await expect(page.locator('.content-item')).toHaveCount(2);
    await expect(page.getByText('Review Azure costs and forecasts.')).toBeVisible();
    await expect(page.locator('.content-icon, .content-path')).toHaveCount(0);
    await expect(page.locator('.details-section pre, .raw')).toHaveCount(0);
    await expect(page.getByText('{"hidden":true}')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Example author' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`plugin-details-${theme}.png`), fullPage: true });
    await page.getByRole('link', { name: 'Example author' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-last-message', '{"type":"external","url":"https://example.com/author"}');
  });
}
