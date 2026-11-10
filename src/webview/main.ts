import type { BrowserSection, State, Message } from '../protocol';
import type { PackageAction } from '../apm/actions';
import { renderActionResult, renderDetailSections } from './details';
import { el } from './dom';
import { filterPackages, filterTokens, sectionPackages, withStatus, withToken, type Filters } from './filter';
import type { Workflow } from '../apm/workflows';
import { scopeKey, scopeKindLabel, scopeLabel } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(message: Message): void; getState(): unknown; setState(value: unknown): void };
const api = acquireVsCodeApi();
const root = document.getElementById('app')!;
type Saved = { search?: string; limit?: Record<string, number>; collapsed?: Partial<Record<BrowserSection, boolean>>; sizes?: Partial<Record<BrowserSection, number>> };
const saved = api.getState() as Saved | undefined;
let state: State;
let search = saved?.search ?? '';
let limits: Record<string, number> = saved?.limit ?? {};
const collapsed = saved?.collapsed ?? {};
const sizes = saved?.sizes ?? {};
let stopResize: (() => void) | undefined;
const send = (message: Message) => api.postMessage(message);
function save() { api.setState({ search, limit: limits, collapsed, sizes }); }
const codicons = {
  clearAll: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M13.5004 12.0004C13.7762 12.0006 14.0004 12.2245 14.0004 12.5004C14.0002 12.7761 13.7761 13.0002 13.5004 13.0004H2.50037C2.22449 13.0004 2.00056 12.7762 2.00037 12.5004C2.00037 12.2244 2.22437 12.0004 2.50037 12.0004H13.5004Z"/><path d="M13.5004 9.00037C13.7762 9.00056 14.0004 9.22449 14.0004 9.50037C14.0002 9.77608 13.7761 10.0002 13.5004 10.0004H2.50037C2.22449 10.0004 2.00056 9.7762 2.00037 9.50037C2.00037 9.22437 2.22437 9.00037 2.50037 9.00037H13.5004Z"/><path d="M13.5004 6.00037C13.7762 6.00056 14.0004 6.22449 14.0004 6.50037C14.0002 6.77608 13.7761 7.00017 13.5004 7.00037H7.50037C7.22449 7.00037 7.00056 6.7762 7.00037 6.50037C7.00037 6.22437 7.22437 6.00037 7.50037 6.00037H13.5004Z"/><path d="M5.50037 0.999023C5.63295 0.999115 5.76009 1.05179 5.85388 1.14551C5.94777 1.23939 6.00037 1.36722 6.00037 1.5C6.00027 1.63265 5.94769 1.75971 5.85388 1.85352L3.7074 4L5.85388 6.14551C5.94777 6.23939 6.00037 6.36722 6.00037 6.5C6.00027 6.63265 5.94769 6.75971 5.85388 6.85352C5.76008 6.94732 5.63302 6.99991 5.50037 7C5.36759 7 5.23976 6.9474 5.14587 6.85352L3.00037 4.70703L0.853882 6.85352C0.760077 6.94732 0.633017 6.99991 0.500366 7C0.36759 7 0.239761 6.9474 0.145874 6.85352C0.0521583 6.75972 -0.000519052 6.63258 -0.000610352 6.5C-0.000610354 6.36722 0.0519875 6.23939 0.145874 6.14551L2.29333 4L0.145874 1.85352C0.0521583 1.75972 -0.000519119 1.63258 -0.000610352 1.5C-0.000610351 1.36722 0.0519874 1.23939 0.145874 1.14551C0.239761 1.05162 0.36759 0.999023 0.500366 0.999023C0.63295 0.999115 0.76009 1.05179 0.853882 1.14551L3.00037 3.29297L5.14587 1.14551C5.23976 1.05162 5.36759 0.999023 5.50037 0.999023Z"/><path d="M13.5004 3.00037C13.7762 3.00056 14.0004 3.22449 14.0004 3.50037C14.0002 3.77608 13.7761 4.00017 13.5004 4.00037H7.50037C7.22449 4.00037 7.00056 3.7762 7.00037 3.50037C7.00037 3.22437 7.22437 3.00037 7.50037 3.00037H13.5004Z"/></svg>',
  filter: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M9.5 14H6.5C6.224 14 6 13.776 6 13.5V9.329C6 8.928 5.844 8.552 5.561 8.268L1.561 4.268C1.205 3.911 1 3.418 1 2.914C1 1.858 1.858 1 2.914 1H13.086C14.142 1 15 1.858 15 2.914C15 3.417 14.796 3.911 14.439 4.267L10.439 8.267C10.156 8.551 10 8.927 10 9.328V13.499C10 13.775 9.776 13.999 9.5 13.999V14ZM7 13H9V9.329C9 8.661 9.26 8.033 9.732 7.561L13.732 3.561C13.902 3.391 14 3.155 14 2.915C14 2.411 13.59 2.001 13.086 2.001H2.914C2.41 2.001 2 2.411 2 2.915C2 3.155 2.098 3.391 2.268 3.562L6.268 7.562C6.741 8.034 7 8.662 7 9.33V13.001V13Z"/></svg>',
};
function button(text: string, action: (event: MouseEvent) => void, className = '') {
  const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node;
}
function action(text: string, type: 'refresh' | 'marketplaces' | 'setup' | 'output' | 'settings' | 'cancel') {
  return button(text, () => send({ type }));
}
function workflowButton(text: string, workflow: Workflow) { return button(text, () => send({ type: 'workflow', workflow })); }
function scopeSummary() {
  const scope = state.scopes.find(scope => `${scope.kind}:${scope.path}` === state.scopeKey);
  return scope ? `${scopeLabel(scope)} — ${state.host ?? 'Local'}` : 'Select an APM scope';
}
function badge(text: string, warning = false) { return el('span', warning ? 'badge warning' : 'badge', text); }
function packageAction(text: string, name: PackageAction, className = '') {
  const node = button(text, () => send({ type: 'packageAction', action: name }), className);
  node.id = `package-action-${name}`;
  node.disabled = state.actionResult?.status === 'running' || !state.trusted || !state.version;
  return node;
}
function header(title: string, subtitle?: string) {
  const node = el('header', 'page-header'); node.append(el('h1', '', title));
  if (subtitle) node.append(el('p', 'muted', subtitle));
  return node;
}
function render() {
  stopResize?.();
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.id : '';
  const selection = document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'text' ? document.activeElement.selectionStart : null;
  const scroll = new Map([...root.querySelectorAll<HTMLElement>('.section-body')].map(body => [body.id, body.scrollTop]));
  root.replaceChildren();
  root.className = state.mode === 'browser' ? 'sidebar' : 'editor';
  root.setAttribute('aria-busy', String(state.busy));
  if (state.mode === 'browser') renderBrowser();
  else {
    renderDetails();
  }
  for (const body of root.querySelectorAll<HTMLElement>('.section-body')) body.scrollTop = scroll.get(body.id) ?? 0;
  if (focused) {
    const input = document.getElementById(focused);
    input?.focus({ preventScroll: true });
    if (input instanceof HTMLInputElement && input.type === 'text' && selection !== null) input.setSelectionRange(selection, selection);
  }
}
function filters(): Filters { return { text: search, marketplace: '', status: '', sort: 'name' }; }
function applySearch(value: string) {
  search = value; limits = {}; save();
  const input = document.getElementById('search') as HTMLInputElement | null;
  if (input) input.value = search;
  const clear = document.querySelector<HTMLButtonElement>('.searchbar .icon-button');
  if (clear) clear.disabled = !search;
  render(); reportFilters();
}
function reportFilters() { send({ type: 'filters', search }); }
function renderBrowser() {
  if (!state.trusted || !state.version) {
    const welcome = el('div', 'sidebar-welcome');
    if (!state.trusted) {
      welcome.append(el('p', '', 'Trust this workspace to browse and manage APM packages.'), button('Manage Workspace Trust', () => send({ type: 'trust' })));
    } else if (!state.busy) {
      welcome.append(el('p', '', 'APM CLI is not available. Install it to browse and manage packages.'), action('Install APM CLI', 'setup'));
      if (state.error || state.errors.length) {
        const output = action('Show Output', 'output'); output.className = 'secondary'; welcome.append(output);
      }
    }
    root.append(welcome);
    return;
  }
  const controls = el('div', 'sidebar-controls');
  if (state.scopes.some(scope => scope.kind === 'workspace') && state.projectPresent === false) controls.append(workflowButton('Initialize APM project', 'initialize'));
  const searchbar = el('div', 'searchbar');
  const input = el('input'); input.type = 'text'; input.id = 'search'; input.placeholder = 'Search packages or @filters'; input.title = 'Search by name or description. Filters: @marketplace:<name>, @installed, @updates, @dependencies, @sort:<order>.'; input.setAttribute('aria-label', 'Filter packages by text or use @marketplace:<name>, @installed, @updates, @dependencies, or @sort:<order>'); input.value = search;
  input.title += ' Scope filters: @scope:workspace, @scope:global.';
  input.setAttribute('aria-label', `${input.getAttribute('aria-label')}, @scope:workspace, or @scope:global`);
  input.addEventListener('input', () => { search = input.value; limits = {}; save(); render(); reportFilters(); });
  const clear = button('', () => { applySearch(''); document.getElementById('search')?.focus(); }, 'icon-button codicon');
  clear.title = 'Clear Search Results and Filters'; clear.setAttribute('aria-label', 'Clear search and filters'); clear.innerHTML = codicons.clearAll; clear.disabled = !search;
  const filter = button('', event => {
    const box = filter.getBoundingClientRect();
    event.preventDefault(); event.stopPropagation();
    filter.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left, clientY: box.bottom }));
  }, 'icon-button codicon filter-button');
  filter.title = 'Filter and sort packages'; filter.setAttribute('aria-label', 'Filter and sort packages'); filter.setAttribute('aria-haspopup', 'menu');
  filter.dataset.vscodeContext = JSON.stringify({ webviewSection: 'filter', preventDefaultContextMenuItems: true });
  filter.innerHTML = codicons.filter;
  searchbar.append(input, clear, filter);
  controls.append(searchbar);
  root.append(controls);
  root.append(el('div', 'browser-context'));
  renderBrowserContents();
}
function renderBrowserContents() {
  const container = root.querySelector('.browser-context');
  if (!container) return;
  container.replaceChildren();
  if (filterTokens(search).dependencies) {
    const summary = el('div', 'dependency-summary');
    summary.append(el('h2', '', 'Dependencies'), el('p', 'muted', scopeSummary()),
      el('p', 'muted', 'Global and current workspace dependencies. Use @scope:global or @scope:workspace to filter.'),
      button('Back to packages', () => applySearch(withStatus(search, '')), 'secondary'));
    container.append(summary);
  }
  const tokens = filterTokens(search);
  const candidates: BrowserSection[] = tokens.dependencies
    ? ['direct', 'transitive', ...(state.installed.some(item => item.direct === undefined) ? ['unclassified' as const] : [])]
    : tokens.installed ? ['installed'] : tokens.updates ? ['updates'] : ['catalog', 'installed', 'updates'];
  const sections = candidates.filter(section => !((section === 'catalog' || section === 'installed' || section === 'updates') && state.hiddenSections?.includes(section)));
  const lists = el('div', 'sections');
  container.append(lists);
  let previous: { section: BrowserSection; node: HTMLElement } | undefined;
  for (const section of sections) {
    const node = el('section', 'package-section');
    node.dataset.section = section;
    node.classList.toggle('collapsed', !!collapsed[section]);
    node.style.flexGrow = String(sectionSize(section));
    const name = sectionNames[section];
    const heading = button('', () => { collapsed[section] = !collapsed[section]; save(); render(); }, 'section-heading');
    heading.id = `section-heading-${section}`;
    heading.setAttribute('aria-expanded', String(!collapsed[section]));
    heading.setAttribute('aria-controls', `section-body-${section}`);
    const twistie = el('span', 'twistie');
    twistie.setAttribute('aria-hidden', 'true');
    heading.append(twistie, el('span', 'section-title', name),
      el('span', 'count-badge', String(filterPackages(sectionPackages(section, state), filters()).length)));
    heading.addEventListener('keydown', event => {
      const index = sections.indexOf(section);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); collapsed[section] = event.key === 'ArrowLeft'; save(); render();
      } else {
        const target = event.key === 'ArrowDown' ? sections[index + 1] : event.key === 'ArrowUp' ? sections[index - 1] :
          event.key === 'Home' ? sections[0] : event.key === 'End' ? sections.at(-1) : undefined;
        if (target) { event.preventDefault(); document.getElementById(`section-heading-${target}`)?.focus(); }
      }
    });
    if (!collapsed[section] && previous) lists.append(sectionSash(previous, { section, node }));
    lists.append(node);
    node.append(heading);
    const body = renderList(section);
    body.id = `section-body-${section}`;
    body.hidden = !!collapsed[section];
    node.append(body);
    if (!collapsed[section]) previous = { section, node };
  }
}
const sectionNames: Record<BrowserSection, string> = { catalog: 'Catalog', installed: 'Installed', updates: 'Updates',
  direct: 'Direct dependencies', transitive: 'Transitive dependencies', unclassified: 'Unclassified dependencies' };
function sectionSize(section: BrowserSection) {
  const size = sizes[section];
  return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 100;
}
function sectionSash(before: { section: BrowserSection; node: HTMLElement }, after: { section: BrowserSection; node: HTMLElement }) {
  const sash = el('div', 'section-sash');
  sash.id = `section-sash-${before.section}-${after.section}`;
  sash.tabIndex = 0;
  sash.setAttribute('role', 'separator');
  sash.setAttribute('aria-orientation', 'horizontal');
  sash.setAttribute('aria-label', `Resize ${sectionNames[before.section]} and ${sectionNames[after.section]}`);
  sash.setAttribute('aria-controls', `section-body-${before.section} section-body-${after.section}`);
  const updateValue = () => {
    sash.setAttribute('aria-valuemin', '0');
    sash.setAttribute('aria-valuemax', '100');
    sash.setAttribute('aria-valuenow', String(Math.round(sectionSize(before.section) / (sectionSize(before.section) + sectionSize(after.section)) * 100)));
  };
  updateValue();
  const resizer = () => {
    const first = before.node.getBoundingClientRect().height - 28;
    const second = after.node.getBoundingClientRect().height - 28;
    const available = first + second;
    const total = sectionSize(before.section) + sectionSize(after.section);
    const minimum = Math.min(20, available / 2);
    return (delta: number) => {
      if (available <= 0) return;
      const next = Math.max(minimum, Math.min(available - minimum, first + delta));
      sizes[before.section] = total * next / available;
      sizes[after.section] = total - sizes[before.section]!;
      before.node.style.flexGrow = String(sizes[before.section]);
      after.node.style.flexGrow = String(sizes[after.section]);
      updateValue();
    };
  };
  sash.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopResize?.();
    sash.focus();
    const resize = resizer(), start = event.clientY;
    sash.setPointerCapture(event.pointerId);
    root.classList.add('resizing');
    const move = (next: PointerEvent) => { if (next.pointerId === event.pointerId) resize(next.clientY - start); };
    const stop = () => {
      sash.removeEventListener('pointermove', move);
      sash.removeEventListener('pointerup', stop);
      sash.removeEventListener('pointercancel', stop);
      sash.removeEventListener('lostpointercapture', stop);
      if (sash.hasPointerCapture(event.pointerId)) sash.releasePointerCapture(event.pointerId);
      root.classList.remove('resizing');
      stopResize = undefined;
      save();
    };
    sash.addEventListener('pointermove', move);
    sash.addEventListener('pointerup', stop);
    sash.addEventListener('pointercancel', stop);
    sash.addEventListener('lostpointercapture', stop);
    stopResize = stop;
  });
  sash.addEventListener('keydown', event => {
    const delta = event.key === 'ArrowUp' ? -10 : event.key === 'ArrowDown' ? 10 :
      event.key === 'Home' ? -Infinity : event.key === 'End' ? Infinity : undefined;
    if (delta === undefined) return;
    event.preventDefault(); resizer()(delta); save();
  });
  return sash;
}
function renderList(section: BrowserSection) {
  const name = sectionNames[section];
  const items = sectionPackages(section, state);
  const dependencies = ['direct', 'transitive', 'unclassified'].includes(section);
  const visible = filterPackages(items, filters());
  const body = el('div', 'section-body');
  body.setAttribute('role', 'region');
  body.setAttribute('aria-label', name);
  const installedErrors = state.errors.filter(error => error.startsWith('Installed:'));
  if (dependencies && installedErrors.length && !visible.some(item => {
    const scope = item.scope;
    return scope && !installedErrors.some(error => error.startsWith(`Installed: ${scope.label}:`));
  })) {
    body.append(el('p', 'empty', 'Dependencies unavailable.'), action('Refresh dependencies', 'refresh'));
    return body;
  }
  if (!visible.length) {
    const narrowed = !!withToken(withStatus(search, ''), '@sort:', '');
    const updateError = state.errors.some(error => error.startsWith('Updates:'));
    const uncertainUpdates = state.installed.some(item =>
      ['unchecked', 'unknown', 'failed'].includes(item.updateStatus ?? '') || item.updateStale
    );
    const incomparableUpdates = state.installed.some(item => item.updateStatus === 'not-comparable');
    const text = name === 'Catalog' && !state.marketplaces.length ? 'No marketplaces registered.' :
      dependencies ? items.length ? 'No dependencies match your filters.' : 'No dependencies in this group.' :
        narrowed ? 'No packages match your filters.' :
        name === 'Updates' ? !state.installed.length ? 'No installed packages to check for updates.' :
          state.busy ? 'Checking for updates…' :
            updateError ? 'Could not check for updates. See APM Output for details.' :
              uncertainUpdates ? 'No updates found, but some packages could not be checked.' :
                incomparableUpdates ? 'No updates found, but some package versions could not be compared.' :
                  'All installed packages are up to date.' :
          'No packages found.';
    body.append(el('p', 'empty', text));
    if (name === 'Updates' && updateError && !narrowed) body.append(action('Show APM Output', 'output'));
    if (name === 'Catalog' && !state.marketplaces.length) body.append(action('Add marketplace', 'marketplaces'));
    if (name === 'Installed' && !items.length && !narrowed) body.append(button('Install a package', () => send({ type: 'install' })));
  }
  const limit = limits[name] ?? 100;
  const list = el('div', 'package-list'); list.setAttribute('role', 'list');
  for (const item of visible.slice(0, limit)) {
    const wrapper = el('div'); wrapper.setAttribute('role', 'listitem');
    const row = button('', () => send({ type: 'details', id: item.id, ...(item.scope ? { scopeKey: scopeKey(item.scope) } : {}) }), 'package-row');
    row.id = `package-${name}-${item.scope ? `${scopeKey(item.scope)}-` : ''}${item.id}`;
    const content = el('span', 'package-content');
    const title = el('span', 'package-title'); title.append(el('strong', '', item.name), el('span', 'version', item.version));
    content.append(title);
    if (item.description) content.append(el('span', 'description', item.description));
    content.append(el('span', 'marketplace', item.marketplace || item.source || 'Direct source'));
    const tags = el('span', 'tags');
    const scopeFilter = filterTokens(search).scope;
    const statuses = name === 'Catalog' && item.installations
      ? item.installations.filter(installation => !scopeFilter || installation.scope?.kind === scopeFilter) : [item];
    for (const installation of statuses) {
      const prefix = name === 'Catalog' && installation.scope ? `${scopeKindLabel(installation.scope)}: ` : '';
      const statusBadge = (text: string, warning = false) => badge(`${prefix}${text}`, warning);
      if (installation.updateStatus === 'outdated') {
        if (name === 'Updates') {
          if (installation.updateStale) tags.append(statusBadge('Cached'));
        } else tags.append(statusBadge(installation.updateStale ? 'Update available (cached)' : 'Update available', true));
      } else if (installation.updateStale) tags.append(statusBadge('Showing saved update status'));
      else if (installation.updateStatus === 'failed' || installation.updateStatus === 'unknown') tags.append(statusBadge('Could not check for updates'));
      else if (installation.updateStatus === 'not-comparable') tags.append(statusBadge('Version could not be compared'));
      else if (installation.updateStatus === 'unchecked') tags.append(statusBadge('Update status not checked'));
    }
    if (item.metadata?.stale) tags.append(badge('Cached catalog'));
    if (item.direct === false) tags.append(badge('Transitive'));
    if (name === 'Catalog') {
      if (item.installations?.some(installation => installation.scope?.kind === 'global')) tags.append(badge('Installed globally'));
      if (item.installations?.some(installation => installation.scope?.kind === 'workspace')) tags.append(badge('Installed in workspace'));
      if (item.installed && !item.installations) tags.append(badge('Installed'));
    } else if (item.scope) tags.append(badge(scopeKindLabel(item.scope)));
    if (tags.childElementCount) content.append(tags);
    row.append(content); wrapper.append(row); list.append(wrapper);
  }
  body.append(list);
  if (visible.length > limit) body.append(button(`Show more (${visible.length - limit} remaining)`, () => { limits[name] = limit + 100; save(); render(); }, 'secondary'));
  return body;
}
function renderDetails() {
  const item = state.item;
  if (!item) { root.append(el('p', '', 'Package details are loading...')); return; }
  root.append(header(item.name, item.description), el('p', 'muted', `${item.marketplace || item.source || 'Direct source'} • ${item.version}`));
  root.append(el('p', 'scope-summary', scopeSummary()));
  const installations = state.installed.filter(installation => installation.id === item.id && installation.scope);
  if (installations.length) {
    const scopes = el('div', 'toolbar');
    for (const installation of installations) {
      const scope = installation.scope!;
      scopes.append(button(`${scopeLabel(scope, true)} (${installation.version})`,
        () => send({ type: 'details', id: installation.id, scopeKey: scopeKey(scope) }), 'secondary'));
    }
    root.append(scopes);
  }
  root.append(el('p', 'muted', item.direct === false ? 'Transitive dependency — update its parent to change the pin.' : item.installed ? 'Direct dependency' : 'Not installed in this scope'));
  const toolbar = el('div', 'toolbar');
  const global = state.scopeKey.startsWith('global:');
  if (item.installed) {
    if (item.updateStatus === 'outdated') toolbar.append(packageAction('Update', 'update'), packageAction('Preview update', 'previewUpdate', 'secondary'));
    toolbar.append(packageAction('Uninstall', 'uninstall', 'secondary'), packageAction('Change version…', 'installWithOptions', 'secondary'));
    if (!global) toolbar.append(packageAction('Audit', 'audit', 'secondary'));
    const scope = state.scopes.find(scope => `${scope.kind}:${scope.path}` === state.scopeKey);
    const dependencies = button(scope?.kind === 'global' ? 'View global dependencies' : 'View workspace dependencies', () => send({ type: 'dependencies' }), 'secondary');
    dependencies.title = 'Shows all dependencies in this scope. Package-specific relationships are not available.';
    toolbar.append(dependencies);
    toolbar.append(packageAction('Install in…', 'install', 'secondary'));
  } else toolbar.append(packageAction('Install', 'install'), packageAction('Install version…', 'installWithOptions', 'secondary'));
  toolbar.append(packageAction('Preview install', 'previewInstall', 'secondary'), packageAction('Preview version…', 'previewWithOptions', 'secondary'));
  if (state.actionResult?.preview && state.actionResult.status === 'success') toolbar.append(packageAction('Review and apply preview options', 'applyPreview'));
  root.append(toolbar);
  if (state.actionResult) root.append(renderActionResult(state.actionResult, () => send({ type: 'cancel' }), id => send({ type: 'navigate', id })));
  const currentScope = state.scopes.find(s => scopeKey(s) === state.scopeKey)?.label;
  const updateMessage = item.updateStatus === 'outdated'
    ? `Update available${item.latestVersion ? `: ${item.latestVersion}` : ''}.${item.updateStale ? ' This is the last known result; refresh to verify.' : ''}`
    : item.updateStatus === 'current' ? 'This package is up to date.'
      : item.updateStatus === 'failed' || item.updateStatus === 'unknown'
        ? `Could not check for updates${item.updateStale ? '; showing the last known result' : ''}.`
        : item.updateStatus === 'not-comparable' ? 'Could not compare this package version with the latest version.'
          : item.updateStatus === 'unchecked' ? 'Update status has not been checked yet.' : undefined;
  if (updateMessage) root.append(el('p', `notice${item.updateStale ? ' warning' : ''}`, `${updateMessage}${currentScope ? ` Scope: ${currentScope}.` : ''}`));
  root.append(renderDetailSections(item, state.details, state.busy, id => send({ type: 'navigate', id })));
  if (state.readmeHtml) {
    const article = el('article', 'readme'); article.innerHTML = state.readmeHtml; root.append(article);
  } else root.append(el('p', 'muted', state.busy ? 'Loading README...' : 'README is not available from this source.'));
}
root.addEventListener('click', event => {
  const link = event.target instanceof Element ? event.target.closest('a') : null;
  if (link) { event.preventDefault(); if (link.href) send({ type: 'external', url: link.href }); }
});
let filtersReported = false;
window.addEventListener('message', (event: MessageEvent<{ type: string; state?: State; search?: string }>) => {
  if (event.data?.type === 'setSearch' && typeof event.data.search === 'string' && state?.mode === 'browser') { applySearch(event.data.search); return; }
  if (event.data?.type !== 'state' || !event.data.state) return;
  if (event.data.state.mode === 'browser' && event.data.state.browserSearch !== undefined) {
    if (search !== event.data.state.browserSearch) limits = {};
    search = event.data.state.browserSearch;
  }
  if (event.data.state.mode === 'browser' && !filtersReported) {
    filtersReported = true; send({ type: 'filters', search });
  }
  state = event.data.state;
  render();
});
send({ type: 'ready' });
