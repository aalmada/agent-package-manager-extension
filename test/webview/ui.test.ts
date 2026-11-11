import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { buildSync } from 'esbuild';
import { descriptors } from '../../src/apm/commands';
import type { BrowserSection, State, Message } from '../../src/protocol';
import { renderMarkdown } from '../../src/views/markdown';
import { parseOutdated } from '../../src/apm/adapters';
import { applyUpdateRows, getUpdateBadge, reconcileDetailContexts, withInstallations } from '../../src/apm/packageState';

const bundle = buildSync({ entryPoints: ['src/webview/main.ts'], bundle: true, write: false, platform: 'browser', format: 'iife' }).outputFiles[0].text;
function browser(section?: BrowserSection, persisted?: unknown) {
  const dom = new JSDOM('<main id="app"></main>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://apm.test' });
  const messages: Message[] = [];
  let saved: unknown = persisted;
  Object.defineProperty(dom.window, 'acquireVsCodeApi', { value: () => ({ getState: () => saved, setState: (value: unknown) => { saved = value; }, postMessage: (message: Message) => messages.push(message) }) });
  dom.window.eval(bundle);
  const state: State = {
    mode: 'browser', browserSearch: section === 'installed' ? '@installed' : section === 'updates' ? '@updates' : undefined,
    trusted: true, projectPresent: true, version: '0.35.0', errors: [], busy: false, scopes: [{ kind: 'workspace', path: '/project', label: 'project' }], scopeKey: 'workspace:/project',
    commands: descriptors, availableCommands: ['install', 'marketplace', 'update', 'view', 'audit', 'deps'],
    marketplaces: [{ name: 'one', source: 'org/one' }, { name: 'two', source: 'org/two' }],
    catalog: [
      { id: 'one::sample', name: 'sample', marketplace: 'one', version: '1.0.0', installed: true, updateStatus: 'outdated' },
      { id: 'two::sample', name: 'sample', marketplace: 'two', version: '2.0.0', installed: false }
    ],
    installed: [{ id: 'one::sample', name: 'sample', marketplace: 'one', version: '0.9.0', installed: true, updateStatus: 'outdated' }]
  };
  const update = () => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'state', state } }));
  update();
  return { dom, document: dom.window.document, messages, state, update, saved: () => saved };
}
test('sidebar has no duplicate scope control, onboarding or deployment sections', () => {
  const page = browser();
  try {
    page.state.host = 'Remote: ssh-remote';
    page.state.projectPresent = true;
    page.update();
    assert.equal(page.document.querySelector('#scope-selector'), null);
    assert.doesNotMatch(page.document.body.textContent ?? '', /Workspace: project|Remote: ssh-remote/);
    const search = page.document.querySelector<HTMLInputElement>('#search')!;
    search.focus(); page.update();
    assert.equal(page.document.activeElement?.id, 'search');
    page.state.targets = [{ target: 'copilot', status: 'active', source: '<script>not executable</script>', deployDir: '.github/' }];
    page.update();
    assert.doesNotMatch(page.document.body.textContent ?? '', /Getting started|Deployment targets|Explain targets|Configure targets|\/project/);
    for (const mode of ['details'] as const) {
      page.state.mode = mode; page.state.item = page.state.catalog[1]; page.update();
      assert.equal(page.document.querySelector('.target-summary'), null);
      assert.equal(page.document.querySelector('.scope-summary')?.textContent, 'Workspace: project — Remote: ssh-remote');
    }
    page.state.mode = 'browser'; page.update();
    const row = page.document.querySelector<HTMLButtonElement>('.package-row')!;
    row.focus(); const id = row.id; page.update();
    assert.equal(page.document.activeElement?.id, id);
    assert.ok(!page.messages.some(message => message.type === 'workflow'));
  } finally { page.dom.window.close(); }
});

test('dual installations have two catalog tags, separate scoped rows and unambiguous navigation', () => {
  const page = browser();
  try {
    const workspace = page.state.scopes[0];
    const global = { kind: 'global' as const, label: 'Global (user)', path: '/user/.apm' };
    page.state.scopes.push(global);
    const project = { ...page.state.installed[0], scope: workspace, direct: true };
    const user = { ...project, scope: global, version: '0.8.0' };
    page.state.installed = [user, project];
    page.state.catalog = withInstallations(page.state.catalog, page.state.installed);
    page.update();
    const catalog = page.document.querySelector('#section-body-catalog .package-row')!;
    assert.match(catalog.textContent ?? '', /Installed globally/);
    assert.match(catalog.textContent ?? '', /Installed in workspace/);
    assert.match(catalog.textContent ?? '', /Global: Update available/);
    assert.match(catalog.textContent ?? '', /Workspace: Update available/);
    const installedRows = [...page.document.querySelectorAll<HTMLButtonElement>('#section-body-installed .package-row')];
    assert.equal(installedRows.length, 2);
    assert.equal(new Set(installedRows.map(row => row.id)).size, 2);
    assert.deepEqual([...installedRows[0].querySelectorAll('.badge')].map(badge => badge.textContent), ['Update available', 'Global']);
    assert.deepEqual([...installedRows[1].querySelectorAll('.badge')].map(badge => badge.textContent), ['Update available', 'Workspace']);
    installedRows[0].click();
    assert.equal(JSON.stringify(page.messages.at(-1)), JSON.stringify({ type: 'details', id: user.id, scopeKey: 'global:/user/.apm' }));
    installedRows[1].click();
    assert.equal(JSON.stringify(page.messages.at(-1)), JSON.stringify({ type: 'details', id: project.id, scopeKey: 'workspace:/project' }));
    assert.equal(page.document.querySelector('#section-heading-updates .count-badge')?.textContent, '2');
    const updateRows = [...page.document.querySelectorAll<HTMLButtonElement>('#section-body-updates .package-row')];
    assert.equal(updateRows.length, 2);
    assert.deepEqual(updateRows.map(row => row.querySelector('.badge')?.textContent), ['Global', 'Workspace']);
    updateRows[1].click();
    assert.equal(JSON.stringify(page.messages.at(-1)), JSON.stringify({ type: 'details', id: project.id, scopeKey: 'workspace:/project' }));
    page.state.browserSearch = '@scope:workspace'; page.update();
    assert.equal(page.document.querySelectorAll('#section-body-installed .package-row').length, 1);
    page.state.browserSearch = '@dependencies @scope:workspace';
    page.state.errors = ['Installed: Global (user): unavailable']; page.update();
    const dependencyRow = page.document.querySelector<HTMLButtonElement>('#section-body-direct .package-row');
    assert.ok(dependencyRow, 'One scope failing must not hide dependencies from the other');
    assert.equal([...dependencyRow.querySelectorAll('.badge')].at(-1)?.textContent, 'Workspace');
    dependencyRow.click();
    assert.equal(JSON.stringify(page.messages.at(-1)), JSON.stringify({ type: 'details', id: project.id, scopeKey: 'workspace:/project' }));
    page.state.errors = [];
    page.state.browserSearch = ''; page.state.mode = 'details'; page.state.item = project; page.update();
    assert.ok([...page.document.querySelectorAll('button')].some(button => button.textContent === 'Global (0.8.0)'));
    assert.ok([...page.document.querySelectorAll('button')].some(button => button.textContent === 'Workspace: project (0.9.0)'));
    assert.ok([...page.document.querySelectorAll('button')].some(button => button.textContent === 'Install in…'));
    page.state.mode = 'browser'; page.state.projectPresent = false; page.state.installed = [user];
    page.state.catalog = withInstallations(page.state.catalog, [user]); page.update();
    assert.ok(page.document.querySelector('#search'));
    assert.match(page.document.querySelector('#section-body-installed')?.textContent ?? '', /Global/);
    assert.doesNotMatch(page.document.querySelector('#section-body-catalog')?.textContent ?? '', /Installed in workspace/);
  } finally { page.dom.window.close(); }
});
test('busy views leave progress to VS Code without refresh buttons or working banners', () => {
  const page = browser();
  try {
    page.state.busy = true;
    page.update();
    assert.equal(page.document.querySelector('#app')?.getAttribute('aria-busy'), 'true');
    assert.doesNotMatch(page.document.body.textContent ?? '', /Cancel refresh|APM is working/);
    assert.equal(page.document.querySelector('.progress'), null);
    assert.ok(page.document.querySelector('#search'));
    assert.ok(page.document.querySelector('.package-row'));
    page.state.mode = 'details'; page.state.item = page.state.installed[0]; page.update();
    assert.doesNotMatch(page.document.body.textContent ?? '', /Cancel refresh|APM is working/);
    page.state.busy = false; page.update();
    assert.equal(page.document.querySelector('#app')?.getAttribute('aria-busy'), 'false');
  } finally { page.dom.window.close(); }
});

test('one browser view keeps search and filter controls above all sections', () => {
  const contributions = JSON.parse(readFileSync('package.json', 'utf8')).contributes;
  assert.equal(contributions.views.apm.length, 1);
  assert.equal(contributions.views.apm[0].id, 'apm.browser');
  assert.equal(contributions.views.apm[0].name, contributions.viewsContainers.activitybar[0].title);
  assert.ok(!contributions.commands.some((command: { command: string }) => command.command === 'apm.getStarted'));
  assert.equal(contributions.walkthroughs, undefined);
  assert.ok(!contributions.views.apm.some((view: { id: string }) => view.id === 'apm.dependencies'));
  assert.ok(contributions.menus['webview/context'].some((entry: { command: string }) => entry.command === 'apm.filter.dependencies'));
  assert.equal(contributions.menus.commandPalette.find((entry: { command: string }) => entry.command === 'apm.filter.dependencies').when, 'false');
  assert.ok(contributions.commands.some((command: { command: string }) => command.command === 'apm.filter.scope.all'));
  assert.ok(!contributions.commands.some((command: { command: string }) => command.command.startsWith('apm.filter.sort.version')));
  const allScopes = contributions.menus['apm.filter.scope'].find((entry: { command: string }) => entry.command === 'apm.filter.scope.all.checked');
  assert.equal(allScopes.when, "(apm.filter.scopeKind == '')");
  for (const id of ['apm.tools', 'apm.previewInstall', 'apm.chooseScope', 'apm.policy']) assert.ok(!contributions.commands.some((command: { command: string }) => command.command === id));
  assert.match(contributions.menus.commandPalette.find((entry: { command: string }) => entry.command === 'apm.runScript').when, /config\.apm\.tasks\.includeScripts/);
});
test('title actions use native overflow with Views before Settings', () => {
  const contributions = JSON.parse(readFileSync('package.json', 'utf8')).contributes;
  const actions = contributions.menus['view/title'];
  assert.deepEqual(actions.filter((item: { group: string }) => item.group === 'navigation').map((item: { command: string }) => item.command), ['apm.refresh']);
  const overflow = actions.filter((item: { group: string }) => item.group !== 'navigation');
  assert.equal(overflow[0].submenu, 'apm.views');
  assert.equal(overflow[1].command, 'apm.settings');
  assert.ok(overflow[0].group < overflow[1].group);
  assert.equal(contributions.submenus.find((item: { id: string }) => item.id === 'apm.views').label, 'Views');
  for (const section of ['catalog', 'installed', 'updates']) {
    const command = `apm.views.${section}`;
    assert.ok(contributions.menus['apm.views'].some((item: { command: string }) => item.command === command));
    assert.equal(contributions.commands.find((item: { command: string }) => item.command === `${command}.checked`).title, `✓ ${section[0].toUpperCase()}${section.slice(1)}`);
    assert.equal(contributions.menus.commandPalette.find((item: { command: string }) => item.command === command).when, 'false');
  }
});
test('all toggle menus use complementary checked and unchecked native entries', () => {
  const contributions = JSON.parse(readFileSync('package.json', 'utf8')).contributes;
  const checked = contributions.commands.filter((item: { command: string }) => item.command.endsWith('.checked'));
  assert.equal(checked.length, 14);
  for (const command of checked) {
    const base = command.command.slice(0, -8);
    const original = contributions.commands.find((item: { command: string }) => item.command === base);
    assert.equal(command.title, `✓ ${original.title}`);
    assert.equal(original.toggled, undefined, 'VS Code does not support contributed command toggle metadata');
    let pairs = 0;
    for (const [menu, entries] of Object.entries(contributions.menus)) {
      if (menu === 'commandPalette') continue;
      const items = entries as { command?: string; when?: string; group?: string }[];
      const plain = items.find(item => item.command === base);
      if (!plain) continue;
      const selected = items.find(item => item.command === command.command)!;
      assert.ok(selected);
      assert.equal(plain.group, selected.group);
      assert.equal(plain.when?.replace('!(', '('), selected.when);
      pairs++;
    }
    assert.ok(pairs > 0);
    assert.equal(contributions.menus.commandPalette.find((item: { command: string }) => item.command === command.command).when, 'false');
  }
});
test('hidden sections remove their headers and sashes but preserve fixed search', () => {
  const page = browser();
  try {
    page.state.hiddenSections = ['installed']; page.update();
    assert.deepEqual([...page.document.querySelectorAll('.section-title')].map(node => node.textContent), ['Catalog', 'Updates']);
    assert.equal(page.document.querySelectorAll('[role="separator"]').length, 1);
    page.document.querySelector<HTMLButtonElement>('#section-heading-catalog')!.focus();
    page.document.activeElement?.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(page.document.activeElement?.id, 'section-heading-updates');
    page.state.hiddenSections = ['catalog', 'installed', 'updates']; page.update();
    assert.equal(page.document.querySelectorAll('.section-heading, [role="separator"]').length, 0);
    assert.ok(page.document.querySelector('#search'));
    page.state.browserSearch = '@dependencies'; page.update();
    assert.equal(page.document.querySelectorAll('.section-heading').length, 3);
    page.state.browserSearch = ''; page.state.hiddenSections = []; page.update();
    assert.equal(page.document.querySelectorAll('.section-heading').length, 3);
    assert.deepEqual([...page.document.querySelectorAll('.count-badge')].map(node => node.textContent), ['2', '1', '1']);
  } finally { page.dom.window.close(); }
});
test('empty installed list opens native package selection, not a command form or preview', () => {
  const page = browser('installed');
  try {
    page.state.installed = [];
    page.update();
    [...page.document.querySelectorAll('button')].find(button => button.textContent === 'Install a package')!.click();
    assert.equal(JSON.stringify(page.messages.at(-1)), '{"type":"install"}');
  } finally { page.dom.window.close(); }
});
test('previews and content navigation use host-validated identities', () => {
  const page = browser();
  try {
    page.state.mode = 'details'; page.state.item = page.state.catalog[1];
    page.state.details = { contents: [{ kind: 'skills', items: [{ name: 'review', path: 'skills/review/SKILL.md', navigationId: 'content:0', locationKind: 'source' }] }] };
    page.state.actionResult = { action: 'previewInstall', preview: true, title: 'Preview', command: 'apm install --dry-run', status: 'success', summary: 'Preview only' };
    page.update();
    page.document.querySelector<HTMLButtonElement>('#package-action-previewInstall')!.click();
    assert.equal(JSON.stringify(page.messages.at(-1)), '{"type":"packageAction","action":"previewInstall"}');
    page.document.querySelector<HTMLButtonElement>('#package-action-applyPreview')!.click();
    assert.equal(JSON.stringify(page.messages.at(-1)), '{"type":"packageAction","action":"applyPreview"}');
    page.document.querySelector<HTMLButtonElement>('#open-content\\:0')!.click();
    assert.equal(JSON.stringify(page.messages.at(-1)), '{"type":"navigate","id":"content:0"}');
    assert.ok(!JSON.stringify(page.messages.at(-1)).includes('SKILL.md'));
  } finally { page.dom.window.close(); }
});
test('missing CLI shows a welcome view instead of package controls and cached lists', () => {
  const page = browser();
  try {
    page.state.version = undefined;
    page.state.error = 'Could not start APM: spawn apm ENOENT';
    page.update();
    assert.match(page.document.querySelector('.sidebar-welcome')?.textContent ?? '', /APM CLI is not available/);
    assert.equal(page.document.querySelectorAll('.sidebar-controls, .notifications, .sections, .package-row, footer').length, 0);
    assert.doesNotMatch(page.document.body.textContent ?? '', /ENOENT|Catalog|Installed|Updates/);
    const buttons = [...page.document.querySelectorAll('button')];
    assert.deepEqual(buttons.map(button => button.textContent), ['Install APM CLI', 'Show Output']);
    buttons[0].click();
    assert.equal(page.messages.at(-1)?.type, 'setup');
    buttons[1].click();
    assert.equal(page.messages.at(-1)?.type, 'output');

    page.state.error = undefined;
    page.state.busy = true;
    page.update();
    assert.equal(page.document.querySelector('#app')?.getAttribute('aria-busy'), 'true');
    assert.doesNotMatch(page.document.body.textContent ?? '', /Checking for APM CLI|Cancel refresh|APM is working/);
    assert.equal(page.document.querySelectorAll('.package-section').length, 0);
    assert.equal(page.document.querySelectorAll('button').length, 0);

    page.state.busy = false;
    page.update();
    assert.deepEqual([...page.document.querySelectorAll('button')].map(button => button.textContent), ['Install APM CLI']);

    page.state.version = '0.35.0';
    page.update();
    assert.equal(page.document.querySelector('.sidebar-welcome'), null);
    assert.ok(page.document.querySelector('#search'));
    assert.equal(page.document.querySelectorAll('.package-row').length, 4);
  } finally { page.dom.window.close(); }
});
test('uninitialized workspace keeps browsing and global management available', () => {
  const page = browser();
  try {
    page.state.projectPresent = false;
    page.update();
    assert.ok(page.document.querySelector('#search'));
    assert.equal(page.document.querySelectorAll('.package-row').length, 4);
    assert.equal(page.document.querySelector('.sidebar-welcome'), null);
    page.document.querySelector<HTMLButtonElement>('button')!.click();
    assert.equal(JSON.stringify(page.messages.at(-1)), '{"type":"workflow","workflow":"initialize"}');
    page.state.projectPresent = true;
    page.update();
    assert.equal(page.document.querySelector('.sidebar-welcome'), null);
    assert.ok(page.document.querySelector('#search'));
    page.state.projectPresent = false;
    page.state.scopes.push({ kind: 'global', label: 'Global (user)', path: '/home/.apm' });
    page.state.scopeKey = 'global:/home/.apm';
    page.update();
    assert.equal(page.document.querySelector('.sidebar-welcome'), null);
    assert.ok(page.document.querySelector('#search'));
    page.state.scopes = page.state.scopes.filter(scope => scope.kind === 'global');
    page.update();
    assert.ok(page.document.querySelector('#search'));
    assert.ok(![...page.document.querySelectorAll('button')].some(button => /project folder|Initialize/.test(button.textContent ?? '')));
    page.state.scopes.push({ kind: 'workspace', path: '/project', label: 'project' });
    page.state.scopeKey = 'workspace:/project';
    page.state.version = undefined;
    page.update();
    assert.equal(page.document.querySelector('button')?.textContent, 'Install APM CLI');
    page.state.trusted = false;
    page.update();
    assert.equal(page.document.querySelector('button')?.textContent, 'Manage Workspace Trust');
  } finally { page.dom.window.close(); }
});
test('restricted workspace shows only the trust welcome action, even with cached CLI state', () => {
  const page = browser();
  try {
    page.state.trusted = false;
    page.update();
    assert.match(page.document.body.textContent ?? '', /Trust this workspace/);
    assert.equal(page.document.querySelectorAll('.package-section, .sidebar-controls, footer').length, 0);
    const buttons = [...page.document.querySelectorAll('button')];
    assert.deepEqual(buttons.map(button => button.textContent), ['Manage Workspace Trust']);
    buttons[0].click();
    assert.equal(page.messages.at(-1)?.type, 'trust');
  } finally { page.dom.window.close(); }
});
test('sidebar renders filtered cards and right-aligned section counts', () => {
  const page = browser();
  try {
    const input = page.document.querySelector<HTMLInputElement>('#search')!;
    assert.match(input.placeholder, /@filters/);
    assert.match(input.getAttribute('aria-label') ?? '', /@marketplace/);
    input.value = '@marketplace:two'; input.dispatchEvent(new page.dom.window.Event('input'));
    assert.equal(JSON.stringify(page.messages.at(-1)), '{"type":"filters","search":"@marketplace:two"}');
    page.state.browserSearch = '@marketplace:two'; page.update();
    assert.equal(page.document.querySelectorAll('.package-row').length, 1);
    page.document.querySelector<HTMLButtonElement>('.package-row')!.click();
    assert.equal(page.messages.at(-1)?.type, 'details');
    assert.equal((page.messages.at(-1) as Extract<Message, { type: 'details' }>).id, 'two::sample');
    page.state.browserSearch = ''; page.update();
    assert.equal(page.document.querySelectorAll('.package-row').length, 4);
    assert.deepEqual([...page.document.querySelectorAll('.count-badge')].map(node => node.textContent), ['2', '1', '1']);
    assert.equal(page.document.querySelector('.version')?.textContent, '1.0.0');
    page.state.browserSearch = '@installed'; page.update();
    assert.equal(page.document.querySelectorAll('.package-row').length, 1);
    assert.equal(page.document.querySelector('.version')?.textContent, '0.9.0');
    page.state.browserSearch = '@updates'; page.update();
    assert.equal(page.document.querySelectorAll('.package-row').length, 1);
    assert.equal(page.document.querySelectorAll('.section-heading, .count-badge, .package-section').length, 3);
    assert.ok(page.document.querySelector('#search'));
  } finally { page.dom.window.close(); }
});
test('operational warnings and errors are not rendered as webview banners', () => {
  const page = browser();
  try {
    page.state.checkedAt = '2026-11-05T10:00:00Z';
    page.update();
    assert.equal(page.document.querySelector('footer'), null);
    assert.doesNotMatch(page.document.body.textContent ?? '', /APM 0\.35\.0|Updates checked/);
    assert.equal([...page.document.querySelectorAll('button')].some(button => button.textContent === 'Update APM'), false);

    page.state.warning = 'This APM version is older than the supported baseline.';
    page.state.error = 'Operation failed';
    page.state.errors = ['Catalog: network unavailable'];
    page.update();
    assert.equal(page.document.querySelectorAll('.notifications, [role="alert"]').length, 0);
    assert.doesNotMatch(page.document.body.textContent ?? '', /older than the supported baseline|Operation failed|network unavailable/);
    assert.equal(page.document.querySelectorAll('footer button').length, 0);
  } finally { page.dom.window.close(); }
});
test('sections support keyboard collapse and navigation without moving search', () => {
  const page = browser('catalog');
  try {
    assert.equal(page.document.querySelectorAll('[role="separator"]').length, 2);
    assert.equal(page.document.querySelector('.sidebar-controls [role="separator"]'), null);
    assert.equal(page.document.querySelector('[role="region"]')?.getAttribute('aria-label'), 'Catalog');
    const press = (key: string) => page.document.activeElement?.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
    page.document.querySelector<HTMLButtonElement>('#section-heading-catalog')!.focus();
    press('ArrowLeft');
    assert.equal(page.document.querySelector('#section-heading-catalog')?.getAttribute('aria-expanded'), 'false');
    assert.equal(page.document.querySelector<HTMLElement>('#section-body-catalog')?.hidden, true);
    assert.equal(page.document.activeElement?.id, 'section-heading-catalog');
    press('ArrowRight');
    assert.equal(page.document.querySelector('#section-heading-catalog')?.getAttribute('aria-expanded'), 'true');
    press('ArrowDown');
    assert.equal(page.document.activeElement?.id, 'section-heading-installed');
    press('End');
    assert.equal(page.document.activeElement?.id, 'section-heading-updates');
    press('Home');
    assert.equal(page.document.activeElement?.id, 'section-heading-catalog');
    assert.ok(page.document.querySelector('#search'));
  } finally { page.dom.window.close(); }
});
test('package sections do not require workspace setup but still require trust and CLI', () => {
  const page = browser('catalog');
  try {
    page.state.projectPresent = undefined; page.update();
    assert.equal(page.document.querySelectorAll('.package-row').length, 4);
    page.state.projectPresent = false; page.update();
    assert.equal(page.document.querySelectorAll('.package-row').length, 4);
    page.state.scopeKey = 'global:/user/.apm'; page.update();
    assert.equal(page.document.querySelectorAll('.package-row').length, 4);
    page.state.version = undefined; page.update();
    assert.equal(page.document.querySelectorAll('.package-row').length, 0);
    page.state.version = '0.35.0'; page.state.trusted = false; page.update();
    assert.equal(page.document.querySelectorAll('.package-row').length, 0);
  } finally { page.dom.window.close(); }
});
test('section sizes and collapse state survive recreation and filter changes', () => {
  const page = browser(undefined, { sizes: { catalog: 150, installed: 50, updates: -1 }, collapsed: { updates: true } });
  try {
    assert.equal(page.document.querySelector<HTMLElement>('[data-section="catalog"]')!.style.flexGrow, '150');
    assert.equal(page.document.querySelector<HTMLElement>('[data-section="installed"]')!.style.flexGrow, '50');
    assert.equal(page.document.querySelector<HTMLElement>('[data-section="updates"]')!.style.flexGrow, '100');
    assert.equal(page.document.querySelector('#section-heading-updates')?.getAttribute('aria-expanded'), 'false');
    assert.equal(page.document.querySelectorAll('[role="separator"]').length, 1);
    page.state.installed.push({ ...page.state.installed[0], id: 'another' }); page.update();
    assert.equal(page.document.querySelector('#section-heading-updates .count-badge')?.textContent, '2');
    page.document.querySelector<HTMLButtonElement>('#section-heading-catalog')!.click();
    const restored = browser(undefined, page.saved());
    try {
      assert.equal(restored.document.querySelector('#section-heading-catalog')?.getAttribute('aria-expanded'), 'false');
      assert.equal(restored.document.querySelector<HTMLElement>('[data-section="catalog"]')!.style.flexGrow, '150');
      const filter = (value: string) => restored.dom.window.dispatchEvent(new restored.dom.window.MessageEvent('message', { data: { type: 'setSearch', search: value } }));
      filter('@dependencies');
      assert.ok(restored.document.querySelector('#section-heading-direct'));
      filter('');
      assert.equal(restored.document.querySelector('#section-heading-catalog')?.getAttribute('aria-expanded'), 'false');
      assert.equal(restored.document.querySelector('.sidebar-controls [role="separator"]'), null);
    } finally { restored.dom.window.close(); }
  } finally { page.dom.window.close(); }
});
test('update empty states are plain-language and stale checks use one badge', () => {
  const page = browser('updates');
  try {
    page.state.installed[0].updateStatus = 'current';
    page.update();
    assert.match(page.document.body.textContent ?? '', /All installed packages are up to date/);

    page.state.installed[0].updateStatus = 'failed';
    page.state.installed[0].updateStale = true;
    page.state.errors = ['Updates: network unavailable'];
    page.state.browserSearch = '@installed'; page.update();
    const installed = page.document.querySelector('.section-body')!;
    assert.equal(installed.querySelectorAll('.badge').length, 1);
    assert.match(installed.textContent ?? '', /Showing saved update status/);
    page.state.browserSearch = '@updates'; page.update();
    const updates = page.document.querySelector('.section-body')!;
    assert.match(updates.textContent ?? '', /Could not check for updates/);
    assert.ok([...updates.querySelectorAll('button')].some(button => button.textContent === 'Show APM Output'));
  } finally { page.dom.window.close(); }
});
test('filter button opens the native VS Code menu and applies host filter changes', () => {
  const page = browser();
  try {
    const labels = [...page.document.querySelectorAll('.sidebar-controls button')].map(b => b.textContent);
    for (const removed of ['Install package', 'Marketplaces', 'Tools', 'Refresh']) assert.ok(!labels.includes(removed), removed);
    assert.equal(page.document.querySelectorAll('.sidebar-controls select, .filter-popup').length, 0);
    assert.equal(JSON.stringify(page.messages.find(m => m.type === 'filters')), JSON.stringify({ type: 'filters', search: '' }));
    const filter = page.document.querySelector<HTMLButtonElement>('.filter-button')!;
    assert.deepEqual(JSON.parse(filter.dataset.vscodeContext!), { webviewSection: 'filter', preventDefaultContextMenuItems: true });
    let menus = 0;
    page.document.addEventListener('contextmenu', event => { menus++; assert.equal(event.target, filter); });
    filter.click();
    assert.equal(menus, 1);
    page.dom.window.dispatchEvent(new page.dom.window.MessageEvent('message', { data: { type: 'setSearch', search: '@marketplace:two' } }));
    assert.equal(page.document.querySelector<HTMLInputElement>('#search')!.value, '@marketplace:two');
    assert.equal(page.document.querySelectorAll('.package-row').length, 1);
    assert.equal(JSON.stringify(page.messages.at(-1)), JSON.stringify({ type: 'filters', search: '@marketplace:two' }));
    assert.equal(page.document.querySelectorAll('.section-heading').length, 3);
  } finally { page.dom.window.close(); }
});
test('large catalogs render incrementally and filtering resets the page limit', () => {
  const page = browser('catalog');
  try {
    page.state.installed = [];
    page.state.catalog = Array.from({ length: 250 }, (_, index) => ({
      id: `one::package-${index}`, name: `package-${String(index).padStart(3, '0')}`,
      marketplace: 'one', version: '1.0.0', installed: false
    }));
    page.update();
    assert.equal(page.document.querySelectorAll('.package-row').length, 100);
    [...page.document.querySelectorAll('button')].find(button => button.textContent === 'Show more (150 remaining)')!.click();
    assert.equal(page.document.querySelectorAll('.package-row').length, 200);
    page.state.browserSearch = 'package-2'; page.update();
    assert.equal(page.document.querySelectorAll('.package-row').length, 50);
    page.state.browserSearch = ''; page.update();
    assert.equal(page.document.querySelectorAll('.package-row').length, 100);
  } finally { page.dom.window.close(); }
});
test('package pages do not expose generic command forms', () => {
  const page = browser();
  try {
    for (const mode of ['browser', 'details'] as const) {
      page.state.mode = mode; page.state.item = page.state.catalog[1]; page.update();
      assert.equal(page.document.querySelector('#command-form, #command-selector'), null);
      assert.doesNotMatch(page.document.body.textContent ?? '', /APM Tools|Review and run|Command help/);
    }
  } finally { page.dom.window.close(); }
});
test('audit results show incomplete coverage, remediation and decoded coordinates safely', () => {
  const page = browser();
  try {
    Object.assign(page.state, { mode: 'details', item: page.state.installed[0], details: {} });
    page.state.actionResult = {
      action: 'audit', title: 'Audit sample', command: 'apm audit sample --format json', status: 'failed',
      audit: {
        passed: false, summary: { files_scanned: 0 },
        coverage: { complete: false, primitives: [{ file: '.github/hooks.json', pointer: '/hooks/0', target: 'copilot', kind: 'hooks', status: 'incomplete', diagnostic: '<img src=x onerror=alert(1)> Unsupported prompt.' }] },
        findings: [
          { severity: 'warning', file: '.github/hooks.json', pointer: '/hooks/0', decodedLine: 3, decodedColumn: 7, category: 'unicode', message: 'Hidden character', remediation: 'Review the decoded prompt.' },
          { severity: 'critical', file: 'a.md', line: 2, column: 8, message: 'Physical source finding' }
        ]
      }
    };
    page.update();
    assert.match(page.document.querySelector('.audit-coverage')?.textContent ?? '', /coverage is incomplete.*not a clean result/s);
    assert.match(page.document.querySelector('.coverage-diagnostics')?.textContent ?? '', /\.github\/hooks\.json.*\/hooks\/0.*copilot.*hooks.*incomplete.*Unsupported prompt/s);
    assert.equal(page.document.querySelector('.audit-coverage img'), null);
    assert.match(page.document.querySelector('.findings')?.textContent ?? '', /\/hooks\/0 decoded 3:7 - unicode.*Remediation: Review the decoded prompt/s);
    assert.match(page.document.querySelector('.findings')?.textContent ?? '', /line 2:8/);
    page.state.actionResult.audit!.coverage = { complete: true, primitives: [] };
    page.update();
    assert.match(page.document.querySelector('.audit-coverage')?.textContent ?? '', /coverage is complete/);
    assert.equal(page.document.querySelector('.coverage-diagnostics'), null);
  } finally { page.dom.window.close(); }
});
test('details present tags, contents and nested metadata without raw JSON', () => {
  const { html } = renderMarkdown('# Title\n\n<script>alert(1)</script>\n\n[x](command:danger)\n\n[site](https://example.com)\n\n![x](javascript:alert(1))');
  assert.ok(html.includes('<h1>Title</h1>')); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('href="command:')); assert.ok(!html.includes('src="javascript:'));
  const page = browser();
  try {
    page.state.mode = 'details';
    page.state.item = { ...page.state.catalog[0], name: 'azure-cost-health-check', installed: false };
    page.state.details = {
      plugin: {
        name: 'azure-cost-health-check', author: { name: 'Example author', url: 'https://example.com/author' },
        license: 'MIT', keywords: ['azure', 'cost-management', 'azure'],
        source: { source: 'github', repo: 'microsoft/azure-dev-tools', path: 'canvases/azure-cost-health-check' }
      },
      packageManifest: {
        skills: ['./skills/azure-cost-health-check/'],
        agents: [{ name: 'Planner', path: './agents/planner.agent.md', description: 'Plans work safely.' }]
      },
      contents: [
        { kind: 'skills', items: [{ name: 'azure-cost-health-check', path: 'skills/azure-cost-health-check/SKILL.md', description: 'Review cost and forecasts.' }] },
        { kind: 'prompts', items: [{ name: 'summarize', path: '.apm/prompts/summarize.prompt.md' }] }
      ],
      marketplace: { name: 'awesome-copilot', plugins: [{ name: 'other-plugin' }] },
      customFutureField: { answer: 42, nested: ['one', 'two'], unsafeLink: 'javascript:alert(1)' },
      rawOutput: '{"shouldNotBeVisible": true}'
    };
    page.state.readmeHtml = html;
    page.update();
    assert.deepEqual([...page.document.querySelectorAll('.detail-tag')].map(element => element.textContent), ['azure', 'cost-management']);
    assert.deepEqual([...page.document.querySelectorAll('.content-group h3')].map(element => element.textContent?.trim()), ['Skills1', 'Agents1', 'Prompts1']);
    assert.equal(page.document.querySelectorAll('.content-item').length, 3);
    assert.match(page.document.querySelector('.content-list')?.textContent ?? '', /Review cost and forecasts/);
    assert.equal(page.document.querySelectorAll('.content-icon, .content-path').length, 0);
    assert.match(page.document.body.textContent ?? '', /Description not available/);
    assert.match(page.document.body.textContent ?? '', /Custom Future Field/);
    assert.match(page.document.body.textContent ?? '', /Answer42/);
    assert.match(page.document.body.textContent ?? '', /microsoft\/azure-dev-tools/);
    assert.doesNotMatch(page.document.body.textContent ?? '', /shouldNotBeVisible|other-plugin|\{"name"/);
    assert.equal(page.document.querySelectorAll('.details-section pre, .raw').length, 0);
    assert.equal(page.document.querySelector('a[href^="javascript:"]'), null);
    const author = page.document.querySelector<HTMLAnchorElement>('a[href="https://example.com/author"]')!;
    assert.equal(author.textContent, 'Example author');
    author.click();
    const message = page.messages.at(-1);
    assert.equal(message?.type, 'external');
    assert.equal(message?.type === 'external' && message.url, 'https://example.com/author');
    assert.equal(page.document.querySelector('.readme h1')?.textContent, 'Title');
    assert.equal(page.document.querySelectorAll('script').length, 0);
  } finally { page.dom.window.close(); }
});
test('README images remain blocked without inline notification banners', () => {
  const source = '![chart](https://images.example.test/chart.png)';
  const blocked = renderMarkdown(source);
  assert.deepEqual(blocked.blockedImages, { https: true, insecure: false });
  assert.doesNotMatch(blocked.html, /src="https:/);
  assert.match(blocked.html, /Image blocked: chart/);
  const allowed = renderMarkdown(source, true);
  assert.deepEqual(allowed.blockedImages, { https: false, insecure: false });
  assert.match(allowed.html, /src="https:\/\/images\.example\.test\/chart\.png"/);
  const insecure = renderMarkdown('![chart](http://images.example.test/chart.png)', true);
  assert.deepEqual(insecure.blockedImages, { https: false, insecure: true });
  assert.doesNotMatch(insecure.html, /src="http:/);
  const unsafeAlt = renderMarkdown('![<img src=x onerror=alert(1)>](https://images.example.test/chart.png)');
  assert.equal(JSDOM.fragment(unsafeAlt.html).querySelector('img, [onerror]'), null);
  const protocolRelative = renderMarkdown('![chart](//images.example.test/chart.png)', true);
  assert.deepEqual(protocolRelative.blockedImages, { https: false, insecure: true });
  assert.doesNotMatch(protocolRelative.html, /<img/);
  const page = browser();
  try {
    page.state.mode = 'details'; page.state.item = page.state.catalog[0];
    page.state.readmeHtml = blocked.html; page.state.readmeImagesBlocked = blocked.blockedImages; page.update();
    assert.doesNotMatch(page.document.body.textContent ?? '', /Remote README images are blocked for privacy/);
    assert.equal([...page.document.querySelectorAll('button')].some(button => button.textContent === 'Open Image Settings'), false);
    page.state.readmeHtml = insecure.html; page.state.readmeImagesBlocked = insecure.blockedImages; page.update();
    assert.doesNotMatch(page.document.body.textContent ?? '', /insecure HTTP or protocol-relative URLs are always blocked/);
    assert.equal([...page.document.querySelectorAll('button')].some(button => button.textContent === 'Open Image Settings'), false);
  } finally { page.dom.window.close(); }
});
test('plugin details describe update state and mark cached results', () => {
  const page = browser();
  try {
    page.state.mode = 'details';
    page.state.item = { ...page.state.installed[0], updateStatus: 'outdated', latestVersion: '1.0.0', updateStale: true };
    page.state.details = {};
    page.update();
    const notice = page.document.querySelector('.notice.warning');
    assert.match(notice?.textContent ?? '', /Update available: 1\.0\.0/);
    assert.match(notice?.textContent ?? '', /last known result; refresh to verify/);
    assert.doesNotMatch(notice?.textContent ?? '', /outdated/);
  } finally { page.dom.window.close(); }
});

test('post-update CLI results reconcile section count, activity badge and open plugin actions', () => {
  const sidebar = browser('updates'), details = browser();
  try {
    const dotnet = {
      ...sidebar.state.installed[0], name: 'dotnet', id: 'one::dotnet',
      metadata: { cliIdentity: 'netfabric/intelligentium/plugins/dotnet' }
    };
    const other = { ...dotnet, name: 'skills', id: 'installed::skills', metadata: { cliIdentity: 'anthropics/skills/skills/skill-creator' } };
    sidebar.state.installed = [dotnet, other];
    sidebar.update();
    details.state.mode = 'details'; details.state.item = dotnet; details.update();
    assert.equal(sidebar.document.querySelectorAll('.package-row').length, 2);
    assert.equal(getUpdateBadge(sidebar.state)?.value, 2);
    assert.ok([...details.document.querySelectorAll('button')].some(button => button.textContent === 'Update'));
    const rows = parseOutdated(
      '| Package | Current | Latest | Status | Source |\n' +
      '| netfabric/intelligentium/plugins/dotnet | dotnet-v0.8.0 | dotnet-v0.8.0 | up-to-date | git tags |\n' +
      '| anthropics/skills/skills/skill-creator | (default) | ca45fc49 | outdated | git branch |'
    );
    sidebar.state.installed = applyUpdateRows(sidebar.state.installed, rows);
    const scope = sidebar.state.scopes[0];
    const context = { scope, item: dotnet };
    reconcileDetailContexts([context], scope, sidebar.state.catalog, sidebar.state.installed, () => {});
    details.state.item = context.item;
    sidebar.update(); details.update();
    const updates = sidebar.document.querySelector('.section-body')!;
    assert.equal(updates.querySelectorAll('.package-row').length, 1);
    assert.doesNotMatch(updates.textContent ?? '', /dotnet/);
    assert.equal(getUpdateBadge(sidebar.state)?.value, 1);
    assert.equal([...details.document.querySelectorAll('button')].some(button => button.textContent === 'Update'), false);
    assert.match(details.document.body.textContent ?? '', /This package is up to date/);
  } finally { sidebar.dom.window.close(); details.dom.window.close(); }
});
test('an open plugin page switches actions when refreshed installation and update state changes', () => {
  const page = browser();
  try {
    page.state.mode = 'details'; page.state.item = page.state.installed[0]; page.state.details = {}; page.update();
    assert.ok([...page.document.querySelectorAll('button')].some(button => button.textContent === 'Update'));
    page.state.item = { ...page.state.item, updateStatus: 'current' }; page.update();
    assert.equal([...page.document.querySelectorAll('button')].some(button => button.textContent === 'Update'), false);
    assert.ok([...page.document.querySelectorAll('button')].some(button => button.textContent === 'Uninstall'));
    page.state.item = { ...page.state.catalog[0], installed: false, updateStatus: undefined }; page.update();
    assert.ok([...page.document.querySelectorAll('button')].some(button => button.textContent === 'Install'));
    assert.equal([...page.document.querySelectorAll('button')].some(button => button.textContent === 'Uninstall'), false);
  } finally { page.dom.window.close(); }
});

test('unavailable contents and unsafe metadata are displayed as text, not markup', () => {
  const page = browser();
  try {
    page.state.mode = 'details';
    page.state.item = page.state.catalog[0];
    page.state.details = {
      plugin: { keywords: ['<img src=x onerror=alert(1)>'] },
      contentsNotice: 'Package source is not available.',
      custom: { '<script>': '<b>untrusted</b>' }
    };
    page.update();
    assert.match(page.document.body.textContent ?? '', /Package contents are not available/);
    assert.match(page.document.body.textContent ?? '', /<b>untrusted<\/b>/);
    assert.equal(page.document.querySelectorAll('script, img, b').length, 0);
  } finally { page.dom.window.close(); }
});

test('extensions are listed and composition warnings appear directly under the Contents heading', () => {
  const page = browser();
  try {
    page.state.mode = 'details';
    page.state.item = page.state.catalog[0];
    page.state.details = {
      contents: [{ kind: 'extensions', items: [{ name: 'board', path: 'extensions/board', description: 'Kanban board.' }] }],
      contentsNotes: ['Declared for the published build.'],
      packageManifest: { extensions: { 'com.github.awesome-copilot': { extensions: ['./extensions/board'] } } }
    };
    page.update();
    const contents = page.document.querySelector('.content-group');
    assert.match(contents?.textContent ?? '', /Extensions1board.*Kanban board\./s);
    const note = page.document.querySelector('.content-note');
    assert.equal(note?.textContent, 'Declared for the published build.');
    assert.ok(note?.classList.contains('warning'));
    assert.equal(note?.previousElementSibling?.textContent, 'Contents');
    assert.doesNotMatch(page.document.body.textContent ?? '', /contents are not available|No listed skills/);
  } finally { page.dom.window.close(); }
});
test('dependency mode groups current-scope packages in the browser and supports filtering, navigation and returning', () => {
  const page = browser();
  try {
    page.state.installed = [
      { ...page.state.installed[0], direct: true },
      { id: 'transitive', name: 'child', version: '1.2.0', installed: true, marketplace: 'two', direct: false },
      { id: 'unknown', name: 'unclassified', version: '1.0.0', installed: true, marketplace: '' }
    ];
    page.state.host = 'Remote: ssh-remote';
    page.update();
    const search = (value: string) => page.dom.window.dispatchEvent(new page.dom.window.MessageEvent('message', { data: { type: 'setSearch', search: value } }));
    search('@dependencies');
    assert.match(page.document.querySelector('.dependency-summary')?.textContent ?? '', /Workspace: project.*Remote: ssh-remote/);
    assert.doesNotMatch(page.document.body.textContent ?? '', /\/project|Catalog|dependency graph/);
    for (const section of ['direct', 'transitive', 'unclassified'] as const) {
      page.state.browserSearch = '@dependencies'; page.update();
      assert.equal(page.document.querySelectorAll(`#section-body-${section} .package-row`).length, 1);
      assert.equal(page.document.querySelector(`#section-heading-${section} .count-badge`)?.textContent, '1');
    }
    page.document.querySelector<HTMLButtonElement>('#package-Transitive\\ dependencies-transitive')!.click();
    assert.equal(JSON.stringify(page.messages.at(-1)), '{"type":"details","id":"transitive"}');
    page.state.browserSearch = '@dependencies @marketplace:two'; page.update();
    assert.equal(page.document.querySelectorAll('.package-row').length, 1);
    page.state.browserSearch = '@dependencies'; page.update();
    search('child @dependencies @sort:name-desc');
    [...page.document.querySelectorAll('button')].find(button => button.textContent === 'Back to packages')!.click();
    assert.equal(page.document.querySelector<HTMLInputElement>('#search')?.value, 'child @sort:name-desc');
    assert.equal(page.document.querySelector('.dependency-summary'), null);
    search('@dependencies');
    page.state.scopeKey = 'global:/user/.apm'; page.state.scopes.push({ kind: 'global', label: 'Global (user)', path: '/user/.apm' });
    page.state.installed = []; page.state.busy = true; page.update();
    assert.match(page.document.querySelector('.dependency-summary')?.textContent ?? '', /Global \(user\)/);
    page.state.busy = false; page.state.browserSearch = '@dependencies'; page.update();
    assert.match(page.document.body.textContent ?? '', /No dependencies in this group/);
    page.state.errors = ['Installed: CLI failed'];
    page.state.installed = [{ id: 'stale', name: 'stale', version: '1', installed: true, marketplace: '', direct: true }];
    page.update();
    assert.equal(page.document.querySelectorAll('.package-row').length, 0);
    assert.match(page.document.body.textContent ?? '', /Dependencies unavailable/);
    [...page.document.querySelectorAll('button')].find(button => button.textContent === 'Refresh dependencies')!.click();
    assert.equal(page.messages.at(-1)?.type, 'refresh');
  } finally { page.dom.window.close(); }
});

test('dependency navigation survives the browser being opened for the first time', () => {
  const page = browser();
  try {
    // A new webview receives the host search before its first filter report.
    const dom = new JSDOM('<main id="app"></main>', { runScripts: 'outside-only' });
    try {
      const messages: Message[] = [];
      Object.defineProperty(dom.window, 'acquireVsCodeApi', { value: () => ({ getState: () => ({ search: '@updates' }), setState: () => {}, postMessage: (message: Message) => messages.push(message) }) });
      dom.window.eval(bundle);
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'state', state: { ...page.state, browserSearch: '@dependencies' } } }));
      assert.equal(dom.window.document.querySelector<HTMLInputElement>('#search')?.value, '@dependencies');
      assert.equal(JSON.stringify(messages.at(-1)), '{"type":"filters","search":"@dependencies"}');
    } finally { dom.window.close(); }
  } finally { page.dom.window.close(); }
});

test('plugin page buttons run package actions and show results in place', () => {
  const page = browser();
  Object.assign(page.state, { mode: 'details', item: page.state.installed[0], details: {} });
  page.update();
  const click = (text: string) => [...page.document.querySelectorAll('button')].find(b => b.textContent === text)!.click();
  for (const text of ['Update', 'Uninstall', 'Change version…', 'Audit']) click(text);
  assert.deepEqual(page.messages.filter(m => m.type === 'packageAction').map(m => 'action' in m && m.action), ['update', 'uninstall', 'installWithOptions', 'audit']);
  click('View workspace dependencies');
  assert.equal(JSON.stringify(page.messages.at(-1)), '{"type":"dependencies"}');
  assert.equal([...page.document.querySelectorAll('button')].some(b => b.textContent === 'Dependency tree'), false);

  page.state.actionResult = { action: 'update', title: 'Update sample', status: 'running', command: 'apm update sample --yes' };
  page.update();
  assert.match(page.document.querySelector('.action-result')!.textContent!, /Update sample.*Running/);
  assert.equal(page.document.querySelector<HTMLButtonElement>('.toolbar button')!.disabled, true);
  click('Cancel');
  assert.equal(JSON.stringify(page.messages.at(-1)), '{"type":"cancel"}');

  page.state.actionResult = { action: 'update', title: 'Update sample', status: 'success', command: 'apm update sample', summary: 'Completed successfully.', output: 'project' };
  page.update();
  assert.equal(page.document.querySelector<HTMLDetailsElement>('.action-output')!.open, true);
  assert.equal([...page.document.querySelectorAll('button')].some(b => b.textContent === 'Available versions'), false);

  page.state.actionResult = { action: 'audit', title: 'Audit sample', status: 'failed', command: 'apm audit sample --format json', summary: 'Findings reported',
    audit: { passed: false, summary: { critical: 1 }, findings: [{ severity: 'critical', file: 'a.md', message: 'Hidden Unicode' }] } };
  page.update();
  assert.match(page.document.querySelector('.findings')!.textContent!, /critical a\.md — Hidden Unicode/);

  Object.assign(page.state, { item: page.state.catalog[1], actionResult: undefined, scopeKey: 'global:/home/.apm' });
  page.update();
  const labels = [...page.document.querySelectorAll('.toolbar button')].map(b => b.textContent);
  assert.deepEqual(labels.slice(0, 2), ['Install', 'Install version…']);
  assert.equal(labels.includes('Audit'), false);
});
