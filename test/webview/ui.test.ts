import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildSync } from 'esbuild';
import { descriptors } from '../../src/apm/commands';
import type { State, Message } from '../../src/protocol';
import { renderMarkdown } from '../../src/views/markdown';

const bundle = buildSync({ entryPoints: ['src/webview/main.ts'], bundle: true, write: false, platform: 'browser', format: 'iife' }).outputFiles[0].text;
function browser() {
  const dom = new JSDOM('<main id="app"></main>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://apm.test' });
  const messages: Message[] = [];
  Object.defineProperty(dom.window, 'acquireVsCodeApi', { value: () => ({ getState: () => undefined, setState: () => {}, postMessage: (message: Message) => messages.push(message) }) });
  dom.window.eval(bundle);
  const state: State = {
    mode: 'browser', trusted: true, version: '0.35.0', errors: [], busy: false, scopes: [{ kind: 'workspace', path: '/project', label: 'project' }], scopeKey: 'workspace:/project',
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
  return { dom, document: dom.window.document, messages, state, update };
}
test('sidebar renders sections, version and marketplace, and filters all three sections', () => {
  const page = browser();
  try {
    assert.equal(page.document.querySelectorAll('.package-section').length, 3);
    assert.equal(page.document.querySelectorAll('.package-row').length, 4);
    assert.equal(page.document.querySelector('.version')?.textContent, '1.0.0');
    const input = page.document.querySelector<HTMLInputElement>('#search')!;
    assert.match(input.placeholder, /@filters/);
    assert.match(input.getAttribute('aria-label') ?? '', /@marketplace/);
    input.value = '@marketplace:two'; input.dispatchEvent(new page.dom.window.Event('input'));
    assert.equal(page.document.querySelectorAll('.package-row').length, 1);
    page.document.querySelector<HTMLButtonElement>('.package-row')!.click();
    assert.equal(page.messages.at(-1)?.type, 'details');
    assert.equal((page.messages.at(-1) as Extract<Message, { type: 'details' }>).id, 'two::sample');
    const clear = [...page.document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Clear search and filters')!; clear.click();
    assert.equal(page.document.querySelectorAll('.package-row').length, 4);
  } finally { page.dom.window.close(); }
});
test('update empty states are plain-language and stale checks use one badge', () => {
  const page = browser();
  try {
    page.state.installed[0].updateStatus = 'current';
    page.update();
    assert.match(page.document.querySelectorAll('.package-section')[2].textContent ?? '', /All installed packages are up to date/);

    page.state.installed[0].updateStatus = 'failed';
    page.state.installed[0].updateStale = true;
    page.state.errors = ['Updates: network unavailable'];
    page.update();
    const installed = page.document.querySelectorAll('.package-section')[1];
    assert.equal(installed.querySelectorAll('.badge').length, 1);
    assert.match(installed.textContent ?? '', /Showing saved update status/);
    const updates = page.document.querySelectorAll('.package-section')[2];
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
    const heading = page.document.querySelector<HTMLButtonElement>('.section-heading')!; heading.click();
    assert.equal(page.document.querySelector('.section-heading')?.getAttribute('aria-expanded'), 'false');
  } finally { page.dom.window.close(); }
});
test('large catalogs render incrementally and filtering resets the page limit', () => {
  const page = browser();
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
    const input = page.document.querySelector<HTMLInputElement>('#search')!;
    input.value = 'package-2'; input.dispatchEvent(new page.dom.window.Event('input'));
    assert.equal(page.document.querySelectorAll('.package-row').length, 50);
    input.value = ''; input.dispatchEvent(new page.dom.window.Event('input'));
    assert.equal(page.document.querySelectorAll('.package-row').length, 100);
  } finally { page.dom.window.close(); }
});
test('visual command forms submit typed arguments and do not reset selection on background refresh', () => {
  const page = browser();
  try {
    page.state.mode = 'tools'; page.state.selectedCommand = 'marketplace add'; page.state.commandRequest = 1; page.state.commandArgs = { source: 'org/repo' }; page.update();
    assert.equal(page.document.querySelector<HTMLInputElement>('#arg-source')!.value, 'org/repo');
    const name = page.document.getElementById('option---name') as HTMLInputElement; name.value = 'custom';
    [...page.document.querySelectorAll('button')].find(b => b.textContent === 'Review and run')!.click();
    assert.equal(page.messages.at(-1)?.type, 'command');
    const message = page.messages.at(-1) as Extract<Message, { type: 'command' }>;
    assert.equal(message.options['--name'], 'custom'); assert.equal(message.args.source, 'org/repo');
    const selector = page.document.querySelector<HTMLSelectElement>('#command-selector')!;
    selector.value = 'marketplace list'; selector.dispatchEvent(new page.dom.window.Event('change'));
    page.update();
    assert.equal(page.document.querySelector<HTMLSelectElement>('#command-selector')!.value, 'marketplace list');
  } finally { page.dom.window.close(); }
});
test('APM Tools shows command results in a structured collapsible panel', () => {
  const page = browser();
  try {
    page.state.mode = 'tools';
    page.state.result = 'Exit code: 2\nAudit found warnings.';
    page.state.error = 'APM exited with code 2.';
    page.update();
    const result = page.document.querySelector('.command-result')!;
    assert.match(result.textContent ?? '', /Command result.*Finished.*Exit code: 2/s);
    assert.equal(result.querySelector('details')?.open, true);
    assert.match(result.querySelector('summary')?.textContent ?? '', /Command output/);
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
test('README images are blocked by default and the notice opens native image settings', () => {
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
    assert.match(page.document.body.textContent ?? '', /Remote README images are blocked for privacy/);
    [...page.document.querySelectorAll('button')].find(button => button.textContent === 'Open Image Settings')!.click();
    assert.equal(page.messages.at(-1)?.type, 'readmeImageSettings');
    page.state.readmeHtml = insecure.html; page.state.readmeImagesBlocked = insecure.blockedImages; page.update();
    assert.match(page.document.body.textContent ?? '', /insecure HTTP or protocol-relative URLs are always blocked/);
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
test('plugin page buttons run package actions and show results in place', () => {
  const page = browser();
  Object.assign(page.state, { mode: 'details', item: page.state.installed[0], details: {} });
  page.update();
  const click = (text: string) => [...page.document.querySelectorAll('button')].find(b => b.textContent === text)!.click();
  for (const text of ['Update', 'Uninstall', 'Change version / target…', 'Audit', 'Dependency tree']) click(text);
  assert.deepEqual(page.messages.filter(m => m.type === 'packageAction').map(m => 'action' in m && m.action), ['update', 'uninstall', 'installWithOptions', 'audit', 'tree']);
  assert.equal(page.messages.some(m => m.type === 'selectCommand'), false);

  page.state.actionResult = { action: 'update', title: 'Update sample', status: 'running', command: 'apm update sample --yes' };
  page.update();
  assert.match(page.document.querySelector('.action-result')!.textContent!, /Update sample.*Running/);
  assert.equal(page.document.querySelector<HTMLButtonElement>('.toolbar button')!.disabled, true);
  click('Cancel');
  assert.equal(JSON.stringify(page.messages.at(-1)), '{"type":"cancel"}');

  page.state.actionResult = { action: 'tree', title: 'Dependency tree', status: 'success', command: 'apm deps tree', summary: 'Completed successfully.', output: 'project' };
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
  assert.deepEqual(labels.slice(0, 2), ['Install', 'Install version / target…']);
  assert.equal(labels.includes('Audit'), false);
});
