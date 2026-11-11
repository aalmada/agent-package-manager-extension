import { test, expect, type Page } from '@playwright/test';
import { descriptors } from '../../src/apm/commands';
import type { State } from '../../src/protocol';
import { withInstallations } from '../../src/apm/packageState';

async function postMessage(page: Page, message: { type: 'state'; state: State } | { type: 'setSearch'; search: string }) {
  await page.evaluate(value => new Promise<void>(resolve => {
    const delivered = (event: MessageEvent) => {
      if (event.source !== window || event.data?.type !== value.type) return;
      window.removeEventListener('message', delivered);
      resolve();
    };
    window.addEventListener('message', delivered);
    window.postMessage(value, '*');
  }), message);
}

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
      Object.defineProperty(window, 'acquireVsCodeApi', { value: () => ({ getState: () => undefined, setState: (value: unknown) => { document.documentElement.dataset.saved = JSON.stringify(value); }, postMessage: (message: unknown) => {
        document.documentElement.dataset.lastMessage = JSON.stringify(message);
      } }) });
    });
    await page.addScriptTag({ path: 'dist/webview.js' });
    const state: State = {
      mode: 'browser', trusted: true, busy: false, errors: [], version: '0.35.0',
      host: 'Remote: ssh-remote', projectPresent: true,
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
    await postMessage(page, { type: 'state', state });
    await expect(page.locator('.package-row')).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'Initialize APM project', exact: true })).toHaveCount(0);
    const initialControls = (await page.locator('.sidebar-controls').boundingBox())!;
    const initialSearchbar = (await page.locator('.searchbar').boundingBox())!;
    expect(initialSearchbar.y - initialControls.y).toBe(8);
    await expect(page.locator('#scope-selector')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /APM installation scope/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Getting started', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Deployment targets' })).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(page.locator('#search')).toBeFocused();
    await postMessage(page, { type: 'state', state });
    await expect(page.locator('#search')).toBeFocused();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('#search')).toHaveCSS('animation-name', 'none');
    await expect(page.locator('footer')).toHaveCount(0);
    await expect(page.locator('.section-heading')).toHaveCount(3);
    await expect(page.locator('.count-badge')).toHaveText(['2', '1', '1']);
    const badgeBox = (await page.locator('.count-badge').first().boundingBox())!;
    expect(badgeBox.x + badgeBox.width).toBe(328);
    expect(await page.locator('.count-badge').first().evaluate(element => getComputedStyle(element).borderRadius)).toBe('11px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`sidebar-${theme}.png`), fullPage: true });
    const workspace = { ...state.installed[0], scope: state.scopes[0] };
    const global = { ...state.installed[0], scope: state.scopes[1], version: '1.0.0' };
    const mixed = { ...state, installed: [global, workspace], catalog: withInstallations(state.catalog, [global, workspace]) };
    await postMessage(page, { type: 'state', state: mixed });
    await expect(page.locator('.count-badge')).toHaveText(['2', '2', '2']);
    await expect(page.locator('#section-body-catalog').getByText('Installed globally', { exact: true })).toBeVisible();
    await expect(page.locator('#section-body-catalog').getByText('Installed in workspace', { exact: true })).toBeVisible();
    const installedRows = page.locator('#section-body-installed .package-row');
    const updateRows = page.locator('#section-body-updates .package-row');
    await expect(installedRows.nth(0).locator('.badge')).toHaveText(['Update available', 'Global']);
    await expect(installedRows.nth(1).locator('.badge')).toHaveText(['Update available', 'Workspace']);
    await expect(updateRows.locator('.badge')).toHaveText(['Global', 'Workspace']);
    await page.screenshot({ path: testInfo.outputPath(`dual-scope-${theme}.png`), fullPage: true });
    await installedRows.first().click();
    await expect(page.locator('html')).toHaveAttribute('data-last-message', JSON.stringify({
      type: 'details', id: global.id, scopeKey: 'global:/home/user/.apm'
    }));
    await installedRows.nth(1).click();
    await expect(page.locator('html')).toHaveAttribute('data-last-message', JSON.stringify({
      type: 'details', id: workspace.id, scopeKey: 'workspace:/project'
    }));
    await updateRows.nth(1).click();
    await expect(page.locator('html')).toHaveAttribute('data-last-message', JSON.stringify({
      type: 'details', id: workspace.id, scopeKey: 'workspace:/project'
    }));
    await page.locator('#search').fill('@scope:global');
    await expect(page.locator('.count-badge')).toHaveText(['1', '1', '1']);
    await page.locator('#search').fill('');
    await postMessage(page, { type: 'state', state: { ...mixed, projectPresent: false, installed: [global],
      catalog: withInstallations(state.catalog, [global]) } });
    await expect(page.locator('#search')).toBeVisible();
    await expect(page.locator('.count-badge')).toHaveText(['2', '1', '1']);
    await expect(page.locator('#section-body-installed').getByText('Global', { exact: true })).toBeVisible();
    await expect(page.locator('#section-body-catalog').getByText('Installed in workspace', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const crowded = { ...state, catalog: Array.from({ length: 60 }, (_, i) => ({ ...state.catalog[0], id: `catalog-${i}`, name: `Package ${i}` })) };
    await postMessage(page, { type: 'state', state: crowded });
    await expect(page.locator('#search')).toBeVisible();
    await expect(page.locator('.count-badge')).toHaveText(['60', '1', '1']);
    await expect(page.getByRole('separator')).toHaveCount(2);
    const catalogBody = page.locator('#section-body-catalog');
    expect(await catalogBody.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await catalogBody.evaluate(element => { element.scrollTop = 300; });
    await postMessage(page, { type: 'state', state: crowded });
    expect(await catalogBody.evaluate(element => element.scrollTop)).toBe(300);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    const controlsBox = await page.locator('.sidebar-controls').boundingBox();
    const catalogBox = (await page.locator('[data-section="catalog"]').boundingBox())!;
    const installedBox = (await page.locator('[data-section="installed"]').boundingBox())!;
    const updatesBox = (await page.locator('[data-section="updates"]').boundingBox())!;
    const sash = page.getByRole('separator').first();
    expect(await sash.evaluate(element => getComputedStyle(element).cursor)).toBe('row-resize');
    const sashBox = (await sash.boundingBox())!;
    await page.mouse.move(sashBox.x + sashBox.width / 2, sashBox.y + 2);
    await page.mouse.down();
    await page.mouse.move(sashBox.x + sashBox.width / 2, sashBox.y + 62);
    await page.mouse.up();
    expect((await page.locator('[data-section="catalog"]').boundingBox())!.height).toBeCloseTo(catalogBox.height + 60, 0);
    expect((await page.locator('[data-section="installed"]').boundingBox())!.height).toBeCloseTo(installedBox.height - 60, 0);
    expect((await page.locator('[data-section="updates"]').boundingBox())!.height).toBeCloseTo(updatesBox.height, 0);
    expect(await page.locator('.sidebar-controls').boundingBox()).toEqual(controlsBox);
    const resized = (await page.locator('[data-section="catalog"]').boundingBox())!.height;
    await postMessage(page, { type: 'state', state: crowded });
    expect((await page.locator('[data-section="catalog"]').boundingBox())!.height).toBeCloseTo(resized, 0);
    expect(await page.locator('html').getAttribute('data-saved')).toContain('"sizes"');
    const value = Number(await sash.getAttribute('aria-valuenow'));
    await sash.focus(); await page.keyboard.press('ArrowUp');
    expect(Number(await sash.getAttribute('aria-valuenow'))).toBeLessThan(value);
    await postMessage(page, { type: 'state', state: crowded });
    await expect(sash).toBeFocused();
    await page.keyboard.press('Home');
    expect((await catalogBody.boundingBox())!.height).toBeCloseTo(20, 0);
    await page.keyboard.press('End');
    expect((await page.locator('#section-body-installed').boundingBox())!.height).toBeCloseTo(20, 0);
    const heading = page.locator('#section-heading-catalog');
    const background = await heading.evaluate(element => getComputedStyle(element).backgroundColor);
    await heading.hover();
    expect(await heading.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(background);
    await heading.focus(); await page.keyboard.press('ArrowLeft');
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#section-body-catalog')).toBeHidden();
    expect((await page.locator('[data-section="catalog"]').boundingBox())!.height).toBe(28);
    expect(await page.locator('.sidebar-controls').boundingBox()).toEqual(controlsBox);
    await page.keyboard.press('ArrowRight');
    await expect(heading).toHaveAttribute('aria-expanded', 'true');
    await postMessage(page, { type: 'state', state });
    await page.evaluate(() => document.addEventListener('contextmenu', event => { document.documentElement.dataset.contextMenu = (event.target as HTMLElement).dataset.vscodeContext ?? ''; }));
    await page.getByLabel('Filter and sort packages').click();
    await expect(page.locator('html')).toHaveAttribute('data-context-menu', /"webviewSection":"filter"/);
    await postMessage(page, { type: 'setSearch', search: '@marketplace:team-skills' });
    await expect(page.locator('#search')).toHaveValue('@marketplace:team-skills');
    await expect(page.locator('.package-row')).toHaveCount(1);
    await expect(page.locator('.count-badge')).toHaveText(['1', '0', '0']);
    await page.getByRole('button', { name: 'Clear search and filters' }).click();
    await expect(page.locator('.package-row')).toHaveCount(4);
    await page.locator('.package-row').first().click();
    await expect(page.locator('html')).toHaveAttribute('data-last-message', '{"type":"details","id":"copilot-plugins::code-review"}');

    const dependencies = { ...state, installed: [
      { ...state.installed[0], direct: true },
      { id: 'team-skills::helper', name: 'helper', marketplace: 'team-skills', version: '1.0.0', installed: true, direct: false }
    ] };
    await postMessage(page, { type: 'state', state: dependencies });
    await postMessage(page, { type: 'setSearch', search: '@dependencies' });
    await expect(page.getByRole('heading', { name: 'Installed dependencies', exact: true })).toBeVisible();
    await expect(page.locator('.dependency-summary')).toContainText('Workspace: My agent project');
    await page.getByRole('button', { name: 'View dependency tree' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-last-message', '{"type":"dependencyTree"}');
    await expect(page.locator('.package-row')).toHaveCount(2);
    await expect(page.locator('.count-badge')).toHaveText(['2']);
    await expect(page.locator('.dependency-group-heading')).toHaveText(['Direct dependencies (1)', 'Transitive dependencies (1)']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`dependencies-${theme}.png`), fullPage: true });
    await page.locator('#search').fill('helper @dependencies');
    await expect(page.locator('.package-row')).toHaveCount(1);
    await page.locator('.package-row').click();
    await expect(page.locator('html')).toHaveAttribute('data-last-message', '{"type":"details","id":"team-skills::helper"}');
    await page.getByRole('button', { name: 'Back to packages', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.dependency-summary')).toHaveCount(0);
    await expect(page.locator('#search')).toHaveValue('helper');
    await page.getByRole('button', { name: 'Clear search and filters' }).click();

    await postMessage(page, { type: 'state', state: { ...state, browserSearch: '', hiddenSections: ['installed'] } });
    await expect(page.locator('.section-title')).toHaveText(['Catalog', 'Updates']);
    await expect(page.getByRole('separator')).toHaveCount(1);
    await expect(page.locator('#search')).toBeVisible();
    await postMessage(page, { type: 'state', state: { ...state, browserSearch: '', hiddenSections: ['catalog', 'installed', 'updates'] } });
    await expect(page.locator('.section-heading')).toHaveCount(0);
    await expect(page.getByRole('separator')).toHaveCount(0);
    await expect(page.locator('#search')).toBeVisible();
    await postMessage(page, { type: 'state', state: { ...state, browserSearch: '' } });
    await expect(page.locator('.section-heading')).toHaveCount(3);

    await page.setViewportSize({ width: 340, height: 250 });
    await expect(page.locator('#search')).toBeInViewport();
    for (const header of await page.locator('.section-heading').all()) await expect(header).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    await page.setViewportSize({ width: 340, height: 900 });

    await postMessage(page, { type: 'state', state: {
      ...state, version: undefined, error: 'Could not start APM: spawn apm ENOENT'
    } });
    await expect(page.getByText('APM CLI is not available. Install it to browse and manage packages.')).toBeVisible();
    await expect(page.locator('.sidebar-controls, .package-section, footer, [role="alert"]')).toHaveCount(0);
    const install = page.getByRole('button', { name: 'Install APM CLI', exact: true });
    await expect(install).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const welcome = await page.locator('.sidebar-welcome').boundingBox();
    const installBox = await install.boundingBox();
    expect(installBox?.width).toBe(300);
    expect(welcome?.y).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`missing-cli-${theme}.png`), fullPage: true });
    await page.keyboard.press('Tab');
    await expect(install).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-last-message', '{"type":"setup"}');
    await page.getByRole('button', { name: 'Show Output', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-last-message', '{"type":"output"}');

    await postMessage(page, { type: 'state', state: { ...state, projectPresent: false } });
    await expect(page.locator('#search')).toBeVisible();
    await expect(page.locator('.package-section')).toHaveCount(3);
    const initialize = page.getByRole('button', { name: 'Initialize APM project', exact: true });
    await expect(initialize).toBeVisible();
    for (const width of [340, 220]) {
      await page.setViewportSize({ width, height: 900 });
      const initializeBox = (await initialize.boundingBox())!;
      const searchbarBox = (await page.locator('.searchbar').boundingBox())!;
      expect(searchbarBox.y - (initializeBox.y + initializeBox.height)).toBeGreaterThanOrEqual(8);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 340, height: 900 });
    await initialize.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-last-message', '{"type":"workflow","workflow":"initialize"}');
    await page.screenshot({ path: testInfo.outputPath(`initialize-project-${theme}.png`), fullPage: true });

    await postMessage(page, { type: 'state', state });
    await expect(page.locator('.sidebar-welcome')).toHaveCount(0);
    await expect(page.locator('#search')).toBeVisible();
    await expect(page.locator('.section-heading')).toHaveCount(3);
    await expect(page.locator('.package-row')).toHaveCount(4);
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
    await postMessage(page, { type: 'state', state });
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

    state.actionResult = {
      action: 'audit', title: 'Audit package', status: 'failed', command: 'apm audit sample --format json',
      summary: 'Audit failed; scan coverage is incomplete.',
      audit: {
        passed: false, summary: { files_scanned: 0 },
        coverage: { complete: false, primitives: [{ file: '.github/hooks.json', pointer: '/hooks/0', target: 'copilot', kind: 'hooks', status: 'incomplete', diagnostic: 'The structured prompt could not be inspected. Review this primitive before trusting the scan.' }] },
        findings: [{ severity: 'warning', file: '.github/hooks.json', pointer: '/hooks/0', decodedLine: 3, decodedColumn: 7, category: 'unicode', message: 'Hidden character in decoded prompt.', remediation: 'Review the source prompt.' }]
      }
    };
    await postMessage(page, { type: 'state', state });
    await expect(page.locator('.audit-coverage')).toContainText('not a clean result');
    await expect(page.locator('.coverage-diagnostics')).toContainText('could not be inspected');
    await expect(page.locator('.findings')).toContainText('decoded 3:7');
    await expect(page.locator('.findings')).toContainText('Remediation: Review the source prompt.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`audit-coverage-${theme}.png`), fullPage: true });
  });
}
