import type { BrowserSection, State, Message } from '../protocol';
import type { PackageAction } from '../apm/actions';
import type { PackageItem, Scope } from '../apm/types';
import { dependencyTreeItem, type DependencyTreeNode } from '../apm/dependencyTree';
import { marketplaceLabel, samePackage } from '../apm/packageState';
import { versionUpdateKind } from '../apm/versions';
import { renderActionResult, renderDetailSections } from './details';
import { el } from './dom';
import { filterPackages, filterTokens, sectionPackages, withStatus, withToken, type Filters } from './filter';
import type { Workflow } from '../apm/workflows';
import { scopeKey, scopeKindLabel } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(message: Message): void; getState(): unknown; setState(value: unknown): void };
const api = acquireVsCodeApi();
const root = document.getElementById('app')!;
type GallerySection = 'catalog' | 'installed' | 'updates' | 'dependencies';
const gallerySections: GallerySection[] = ['catalog', 'installed', 'updates', 'dependencies'];
type DependencyView = 'list' | 'tree';
type Saved = { search?: string; limit?: Record<string, number>; collapsed?: Partial<Record<BrowserSection, boolean>>; sizes?: Partial<Record<BrowserSection, number>>;
  gallerySection?: GallerySection; dependencyView?: DependencyView; dependencyScope?: string };
const saved = api.getState() as Saved | undefined;
let state: State;
let search = saved?.search ?? '';
let limits: Record<string, number> = saved?.limit ?? {};
const collapsed = saved?.collapsed ?? {};
const sizes = saved?.sizes ?? {};
let gallerySection: GallerySection = gallerySections.find(section => section === saved?.gallerySection) ?? 'catalog';
let dependencyView: DependencyView = saved?.dependencyView === 'tree' ? 'tree' : 'list';
let dependencyScope = typeof saved?.dependencyScope === 'string' ? saved.dependencyScope : '';
const collapsedTree = new Set<string>();
let treeFocus = '';
let galleryScroll = 0;
let galleryFocus = '';
let stopResize: (() => void) | undefined;
const send = (message: Message) => api.postMessage(message);
function save() { api.setState({ search, limit: limits, collapsed, sizes, gallerySection, dependencyView, dependencyScope }); }
const codicons = {
  clearAll: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M13.5004 12.0004C13.7762 12.0006 14.0004 12.2245 14.0004 12.5004C14.0002 12.7761 13.7761 13.0002 13.5004 13.0004H2.50037C2.22449 13.0004 2.00056 12.7762 2.00037 12.5004C2.00037 12.2244 2.22437 12.0004 2.50037 12.0004H13.5004Z"/><path d="M13.5004 9.00037C13.7762 9.00056 14.0004 9.22449 14.0004 9.50037C14.0002 9.77608 13.7761 10.0002 13.5004 10.0004H2.50037C2.22449 10.0004 2.00056 9.7762 2.00037 9.50037C2.00037 9.22437 2.22437 9.00037 2.50037 9.00037H13.5004Z"/><path d="M13.5004 6.00037C13.7762 6.00056 14.0004 6.22449 14.0004 6.50037C14.0002 6.77608 13.7761 7.00017 13.5004 7.00037H7.50037C7.22449 7.00037 7.00056 6.7762 7.00037 6.50037C7.00037 6.22437 7.22437 6.00037 7.50037 6.00037H13.5004Z"/><path d="M5.50037 0.999023C5.63295 0.999115 5.76009 1.05179 5.85388 1.14551C5.94777 1.23939 6.00037 1.36722 6.00037 1.5C6.00027 1.63265 5.94769 1.75971 5.85388 1.85352L3.7074 4L5.85388 6.14551C5.94777 6.23939 6.00037 6.36722 6.00037 6.5C6.00027 6.63265 5.94769 6.75971 5.85388 6.85352C5.76008 6.94732 5.63302 6.99991 5.50037 7C5.36759 7 5.23976 6.9474 5.14587 6.85352L3.00037 4.70703L0.853882 6.85352C0.760077 6.94732 0.633017 6.99991 0.500366 7C0.36759 7 0.239761 6.9474 0.145874 6.85352C0.0521583 6.75972 -0.000519052 6.63258 -0.000610352 6.5C-0.000610354 6.36722 0.0519875 6.23939 0.145874 6.14551L2.29333 4L0.145874 1.85352C0.0521583 1.75972 -0.000519119 1.63258 -0.000610352 1.5C-0.000610351 1.36722 0.0519874 1.23939 0.145874 1.14551C0.239761 1.05162 0.36759 0.999023 0.500366 0.999023C0.63295 0.999115 0.76009 1.05179 0.853882 1.14551L3.00037 3.29297L5.14587 1.14551C5.23976 1.05162 5.36759 0.999023 5.50037 0.999023Z"/><path d="M13.5004 3.00037C13.7762 3.00056 14.0004 3.22449 14.0004 3.50037C14.0002 3.77608 13.7761 4.00017 13.5004 4.00037H7.50037C7.22449 4.00037 7.00056 3.7762 7.00037 3.50037C7.00037 3.22437 7.22437 3.00037 7.50037 3.00037H13.5004Z"/></svg>',
  filter: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M9.5 14H6.5C6.224 14 6 13.776 6 13.5V9.329C6 8.928 5.844 8.552 5.561 8.268L1.561 4.268C1.205 3.911 1 3.418 1 2.914C1 1.858 1.858 1 2.914 1H13.086C14.142 1 15 1.858 15 2.914C15 3.417 14.796 3.911 14.439 4.267L10.439 8.267C10.156 8.551 10 8.927 10 9.328V13.499C10 13.775 9.776 13.999 9.5 13.999V14ZM7 13H9V9.329C9 8.661 9.26 8.033 9.732 7.561L13.732 3.561C13.902 3.391 14 3.155 14 2.915C14 2.411 13.59 2.001 13.086 2.001H2.914C2.41 2.001 2 2.411 2 2.915C2 3.155 2.098 3.391 2.268 3.562L6.268 7.562C6.741 8.034 7 8.662 7 9.33V13.001V13Z"/></svg>',
  back: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M13.5 7.5H3.707l4.147-4.146a.5.5 0 1 0-.708-.708l-5 5a.5.5 0 0 0 0 .708l5 5a.5.5 0 0 0 .708-.708L3.707 8.5H13.5a.5.5 0 0 0 0-1Z"/></svg>',
  refresh: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M3 8a5 5 0 0 1 9-3h-2a.5.5 0 0 0 0 1h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-1 0v1.531A6 6 0 1 0 13.978 8.518a.5.5 0 1 0-.997-.085A5 5 0 0 1 3 8Z"/></svg>',
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
  return scope ? `${scopeKindLabel(scope)} — ${state.host ?? 'Local'}` : 'Select an APM scope';
}
function badge(text: string) { return el('span', 'badge', text); }
function origin(item: PackageItem) { return marketplaceLabel(item) || item.source || 'Direct source'; }
function installationTag(section: BrowserSection | 'details', installation: PackageItem, select?: () => void) {
  const outdated = installation.updateStatus === 'outdated';
  const kind = outdated ? versionUpdateKind(installation.version, installation.latestVersion) : undefined;
  const updateLabel = kind === undefined ? undefined : kind === 'available' ? 'Update available'
    : `${kind[0].toUpperCase()}${kind.slice(1)} update`;
  const status = section === 'updates' ? outdated ? `${updateLabel}${installation.updateStale ? ' (cached)' : ''}`
    : installation.updateStale ? 'Cached' : undefined
    : outdated ? `${updateLabel}${installation.updateStale ? ' (cached)' : ''}`
      : installation.updateStale ? 'Showing saved update status'
        : installation.updateStatus === 'failed' || installation.updateStatus === 'unknown' ? 'Could not check for updates'
          : installation.updateStatus === 'not-comparable' ? 'Version could not be compared'
            : section === 'catalog' || section === 'details' ? 'Installed' : undefined;
  const scope = installation.scope ? scopeKindLabel(installation.scope) : undefined;
  const text = scope && status ? `${scope}: ${status}` : scope ?? status;
  if (!text) return undefined;
  const tag = select ? button(text, select, 'badge') : badge(text);
  if (kind) {
    tag.classList.add('update-type', `update-type-${kind}`);
    if (installation.latestVersion) {
      const note = kind === 'major' ? 'This may include incompatible changes; review release notes before updating.'
        : kind === 'available' ? 'Review release notes to understand the changes.'
          : 'This label describes the SemVer version bump; review release notes for exact changes.';
      tag.title = `${installation.version} → ${installation.latestVersion}. ${note}`;
    }
  }
  return tag;
}
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
function iconButton(label: string, icon: keyof typeof codicons, action: (event: MouseEvent) => void, className = '') {
  const node = button('', action, `icon-button codicon ${className}`.trim());
  node.title = label; node.setAttribute('aria-label', label); node.innerHTML = codicons[icon];
  return node;
}
function isGallery() { return state.mode === 'gallery' || !!state.gallery; }
function render() {
  stopResize?.();
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.id : '';
  const selection = document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'text' ? document.activeElement.selectionStart : null;
  const scroll = new Map([...root.querySelectorAll<HTMLElement>('.section-body, .gallery-sidebar')].map(body => [body.id, body.scrollTop]));
  const main = document.getElementById('gallery-main');
  const page = root.dataset.page, pageItem = root.dataset.item;
  if (main && page === 'list') galleryScroll = main.scrollTop;
  const detailsScroll = main && page === 'details' ? main.scrollTop : 0;
  root.replaceChildren();
  const gallery = isGallery();
  root.className = state.mode === 'browser' ? 'sidebar' : gallery ? 'gallery' : 'editor';
  root.setAttribute('aria-busy', String(state.busy));
  const itemKey = state.item ? `${state.scopeKey}|${state.item.id}` : '';
  if (gallery) Object.assign(root.dataset, { page: state.mode === 'details' ? 'details' : 'list', item: itemKey });
  else { delete root.dataset.page; delete root.dataset.item; }
  if (state.mode === 'browser') renderBrowser();
  else if (gallery) renderGallery();
  else renderDetails(root);
  for (const body of root.querySelectorAll<HTMLElement>('.section-body, .gallery-sidebar')) body.scrollTop = scroll.get(body.id) ?? 0;
  const nextMain = document.getElementById('gallery-main');
  if (nextMain) nextMain.scrollTop = root.dataset.page === 'list' ? galleryScroll : page === 'details' && pageItem === itemKey ? detailsScroll : 0;
  if (gallery && page && page !== root.dataset.page) {
    const target = root.dataset.page === 'details' ? document.getElementById('gallery-back')
      : document.getElementById(galleryFocus) ?? document.getElementById('search');
    target?.focus({ preventScroll: true });
  } else if (focused) {
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
function welcome(className: string) {
  const node = el('div', className);
  if (!state.trusted) {
    node.append(el('p', '', 'Trust this workspace to browse and manage APM packages.'), button('Manage Workspace Trust', () => send({ type: 'trust' })));
  } else if (!state.busy) {
    node.append(el('p', '', 'APM CLI is not available. Install it to browse and manage packages.'), action('Install APM CLI', 'setup'));
    if (state.error || state.errors.length) {
      const output = action('Show Output', 'output'); output.className = 'secondary'; node.append(output);
    }
  }
  return node;
}
function searchBar(showMenu = true) {
  const searchbar = el('div', 'searchbar');
  const input = el('input'); input.type = 'text'; input.id = 'search'; input.placeholder = 'Search packages or @filters'; input.title = 'Search by name or description. Filters: @marketplace:<name>, @installed, @updates, @dependencies, @sort:<order>.'; input.setAttribute('aria-label', 'Filter packages by text or use @marketplace:<name>, @installed, @updates, @dependencies, or @sort:<order>'); input.value = search;
  input.title += ' Scope filters: @scope:workspace, @scope:global.';
  input.setAttribute('aria-label', `${input.getAttribute('aria-label')}, @scope:workspace, or @scope:global`);
  input.addEventListener('input', () => { search = input.value; limits = {}; save(); render(); reportFilters(); });
  const clear = iconButton('Clear Search Results and Filters', 'clearAll', () => { applySearch(''); document.getElementById('search')?.focus(); });
  clear.setAttribute('aria-label', 'Clear search and filters'); clear.disabled = !search;
  searchbar.append(input, clear);
  if (showMenu) {
    const filter = iconButton('Filter and sort packages', 'filter', event => {
      const box = filter.getBoundingClientRect();
      event.preventDefault(); event.stopPropagation();
      filter.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left, clientY: box.bottom }));
    }, 'filter-button');
    filter.setAttribute('aria-haspopup', 'menu');
    filter.dataset.vscodeContext = JSON.stringify({ webviewSection: 'filter', preventDefaultContextMenuItems: true });
    searchbar.append(filter);
  }
  return searchbar;
}
function renderBrowser() {
  if (!state.trusted || !state.version) {
    root.append(welcome('sidebar-welcome'));
    return;
  }
  const controls = el('div', 'sidebar-controls');
  if (state.scopes.some(scope => scope.kind === 'workspace') && state.projectPresent === false) controls.append(workflowButton('Initialize APM project', 'initialize'));
  controls.append(searchBar());
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
    summary.append(el('h2', '', 'Installed dependencies'), el('p', 'muted', scopeSummary()),
      el('p', 'muted', 'Global and current workspace dependencies. Use @scope:global or @scope:workspace to filter.'),
      button('View dependency tree', () => send({ type: 'dependencyTree' }), 'secondary'),
      button('Back to packages', () => applySearch(withStatus(search, '')), 'secondary'));
    container.append(summary);
  }
  const tokens = filterTokens(search);
  const candidates: BrowserSection[] = tokens.dependencies
    ? ['installed']
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
  if (section === 'installed' && filterTokens(search).dependencies) {
    const body = el('div', 'section-body dependency-groups');
    body.setAttribute('role', 'region');
    body.setAttribute('aria-label', 'Installed dependencies');
    const groups: BrowserSection[] = ['direct', 'transitive', ...(state.installed.some(item => item.direct === undefined) ? ['unclassified' as const] : [])];
    for (const group of groups) {
      const items = filterPackages(sectionPackages(group, state), filters());
      const sectionElement = el('section', 'dependency-group');
      const groupBody = renderList(group);
      groupBody.id = `section-body-${group}`;
      sectionElement.append(el('h3', 'dependency-group-heading', `${sectionNames[group]} (${items.length})`), groupBody);
      body.append(sectionElement);
    }
    return body;
  }
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
  if (!visible.length) body.append(...emptyContent(section, items.length));
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
    content.append(el('span', 'marketplace', origin(item)));
    const tags = packageTags(section, item);
    if (tags) content.append(tags);
    row.append(content); wrapper.append(row); list.append(wrapper);
  }
  body.append(list);
  if (visible.length > limit) body.append(button(`Show more (${visible.length - limit} remaining)`, () => { limits[name] = limit + 100; save(); render(); }, 'secondary'));
  return body;
}
function emptyContent(section: BrowserSection, total: number) {
  const dependencies = ['direct', 'transitive', 'unclassified'].includes(section);
  const narrowed = !!withToken(withStatus(search, ''), '@sort:', '');
  const updateError = state.errors.some(error => error.startsWith('Updates:'));
  const uncertainUpdates = state.installed.some(item =>
    ['unchecked', 'unknown', 'failed'].includes(item.updateStatus ?? '') || item.updateStale
  );
  const incomparableUpdates = state.installed.some(item => item.updateStatus === 'not-comparable');
  const text = section === 'catalog' && !state.marketplaces.length ? 'No marketplaces registered.' :
    dependencies ? total ? 'No dependencies match your filters.' : 'No dependencies in this group.' :
      narrowed ? 'No packages match your filters.' :
      section === 'updates' ? !state.installed.length ? 'No installed packages to check for updates.' :
        state.busy ? 'Checking for updates…' :
          updateError ? 'Could not check for updates. See APM Output for details.' :
            uncertainUpdates ? 'No updates found, but some packages could not be checked.' :
              incomparableUpdates ? 'No updates found, but some package versions could not be compared.' :
                'All installed packages are up to date.' :
        'No packages found.';
  const nodes: HTMLElement[] = [el('p', 'empty', text)];
  if (section === 'updates' && updateError && !narrowed) nodes.push(action('Show APM Output', 'output'));
  if (section === 'catalog' && !state.marketplaces.length) nodes.push(action('Add marketplace', 'marketplaces'));
  if (section === 'installed' && !total && !narrowed) nodes.push(button('Install a package', () => send({ type: 'install' })));
  return nodes;
}
function packageTags(section: BrowserSection, item: PackageItem) {
  const tags = el('span', 'tags');
  const scopeFilter = filterTokens(search).scope;
  const installations = section !== 'catalog' ? [item]
    : item.installations?.filter(installation => !scopeFilter || installation.scope?.kind === scopeFilter) ?? (item.installed ? [item] : []);
  for (const installation of installations) {
    const tag = installationTag(section, installation);
    if (tag) tags.append(tag);
  }
  if (item.metadata?.stale) tags.append(badge('Cached catalog'));
  if (item.direct === false) {
    const transitive = badge('Transitive');
    if (item.requiredBy?.length) transitive.title = requiredByText(item);
    tags.append(transitive);
  }
  return tags.childElementCount ? tags : undefined;
}
function requiredByText(item: PackageItem) { return `Required by ${item.requiredBy!.map(parent => parent.name).join(', ')}`; }
function openPackage(item: PackageItem) {
  send({ type: 'details', id: item.id, ...(item.scope ? { scopeKey: scopeKey(item.scope) } : {}) });
}
const galleryHeadings: Record<GallerySection, [string, string, string]> = {
  catalog: ['Catalog', 'Browse packages', 'Discover agent packages from your registered marketplaces.'],
  installed: ['Installed', 'Installed packages', 'Packages installed globally and in the current workspace.'],
  updates: ['Updates', 'Package updates', 'Installed packages with a newer version available.'],
  dependencies: ['Dependencies', 'Dependencies', 'Direct and transitive packages installed globally and in the current workspace.']
};
function currentGallerySection(): GallerySection {
  const tokens = filterTokens(search);
  return tokens.dependencies ? 'dependencies' : tokens.installed ? 'installed' : tokens.updates ? 'updates' : gallerySection;
}
function galleryPackages(section: GallerySection) { return section === 'dependencies' ? state.installed : sectionPackages(section, state); }
function galleryFilters(): Filters { return { ...filters(), text: withStatus(search, '') }; }
function selectGallerySection(section: GallerySection) {
  gallerySection = section; galleryScroll = 0; galleryFocus = `gallery-nav-${section}`;
  save();
  if (state.mode === 'details') send({ type: 'back' });
  const next = withStatus(search, '');
  if (next !== search) applySearch(next);
  else if (state.mode !== 'details') render();
}
function renderGallery() {
  const ready = state.trusted && !!state.version;
  const current = currentGallerySection();
  const sidebar = el('div', 'gallery-sidebar'); sidebar.id = 'gallery-sidebar';
  const nav = el('nav', 'gallery-nav');
  nav.setAttribute('aria-label', 'Package sections');
  for (const section of gallerySections) {
    const item = button('', () => selectGallerySection(section), 'gallery-nav-item');
    item.id = `gallery-nav-${section}`;
    item.classList.toggle('selected', section === current);
    if (section === current && state.mode !== 'details') item.setAttribute('aria-current', 'page');
    item.append(el('span', 'gallery-nav-label', galleryHeadings[section][0]));
    if (ready) item.append(el('span', 'gallery-nav-count', String(filterPackages(galleryPackages(section), galleryFilters()).length)));
    item.disabled = !ready;
    item.addEventListener('keydown', event => {
      const index = gallerySections.indexOf(section);
      const target = event.key === 'ArrowDown' ? gallerySections[index + 1] : event.key === 'ArrowUp' ? gallerySections[index - 1] :
        event.key === 'Home' ? gallerySections[0] : event.key === 'End' ? gallerySections.at(-1) : undefined;
      if (target) { event.preventDefault(); document.getElementById(`gallery-nav-${target}`)?.focus(); }
    });
    nav.append(item);
  }
  const main = el('div', 'gallery-main'); main.id = 'gallery-main';
  const content = el('div', 'gallery-content');
  main.append(content);
  sidebar.append(nav);
  if (ready && state.mode !== 'details') sidebar.append(galleryFilterPanel(current));
  root.append(sidebar, main);
  if (!ready) content.append(welcome('gallery-welcome'));
  else if (state.mode === 'details') renderDetails(content);
  else renderGalleryList(content, current);
}
function renderGalleryList(content: HTMLElement, section: GallerySection) {
  const [, title, subtitle] = galleryHeadings[section];
  const head = el('header', 'gallery-header');
  const titles = el('div', 'gallery-titles');
  titles.append(el('h1', '', title), el('p', 'muted', subtitle));
  const refresh = iconButton('Refresh packages', 'refresh', () => send({ type: 'refresh' }));
  refresh.id = 'gallery-refresh'; refresh.disabled = state.busy;
  head.append(titles, refresh);
  const controls = el('div', 'gallery-controls');
  controls.append(searchBar(false));
  if (state.busy) {
    const progress = el('div', 'gallery-progress');
    progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-label', 'Refreshing packages');
    controls.append(progress);
  }
  content.append(head, controls);
  if (state.scopes.some(scope => scope.kind === 'workspace') && state.projectPresent === false) {
    const toolbar = el('div', 'toolbar'); toolbar.append(workflowButton('Initialize APM project', 'initialize')); content.append(toolbar);
  }
  if (section === 'dependencies') { renderDependencies(content); return; }
  const items = filterPackages(sectionPackages(section, state), galleryFilters());
  const groups = new Map<string, PackageItem[]>();
  for (const item of items) {
    const label = marketplaceLabel(item);
    groups.set(label, [...groups.get(label) ?? [], item]);
  }
  renderGalleryGroups(content, section, [...groups].sort(([a], [b]) => !a ? 1 : !b ? -1 : a.localeCompare(b))
    .map(([label, items]) => ({ key: section, title: label || 'Other sources', items })),
  () => emptyContent(section, sectionPackages(section, state).length));
}
function renderDependencies(content: HTMLElement) {
  const views = el('div', 'toolbar dependency-views');
  views.setAttribute('role', 'group'); views.setAttribute('aria-label', 'Dependency view');
  for (const [view, label] of [['list', 'List'], ['tree', 'Tree']] as const) {
    const toggle = button(label, () => { dependencyView = view; save(); render(); }, 'secondary');
    toggle.id = `dependency-view-${view}`;
    toggle.setAttribute('aria-pressed', String(dependencyView === view));
    views.append(toggle);
  }
  content.append(views);
  if (dependencyView === 'tree') { renderDependencyTree(content); return; }
  const groups: BrowserSection[] = ['direct', 'transitive', ...(state.installed.some(item => item.direct === undefined) ? ['unclassified' as const] : [])];
  renderGalleryGroups(content, 'dependencies', groups.map(group => ({
    key: group, title: sectionNames[group], items: filterPackages(sectionPackages(group, state), galleryFilters())
  })), () => state.installed.length ? [el('p', 'empty', 'No dependencies match your filters.')]
    : [el('p', 'empty', 'No dependencies installed.'), button('Install a package', () => send({ type: 'install' }))]);
}
/** The tree runs per scope: the current workspace and global, narrowed by an `@scope:` filter. */
function dependencyScopes(): Scope[] {
  const filter = filterTokens(search).scope;
  const workspace = state.scopes.find(scope => scope.kind === 'workspace' && scopeKey(scope) === state.scopeKey) ?? state.scopes.find(scope => scope.kind === 'workspace');
  const global = state.scopes.find(scope => scope.kind === 'global');
  return [workspace, global].filter((scope): scope is Scope => !!scope && (!filter || scope.kind === filter));
}
function renderDependencyTree(content: HTMLElement) {
  const scopes = dependencyScopes();
  const scope = scopes.find(candidate => scopeKey(candidate) === dependencyScope) ?? scopes[0];
  if (!scope) { content.append(el('p', 'empty', 'No package scope matches your filters.')); return; }
  const key = scopeKey(scope), tree = state.dependencyTrees?.[key], loaded = !!tree?.root || !!tree?.error;
  const toolbar = el('div', 'toolbar dependency-tree-toolbar');
  if (scopes.length > 1) {
    const select = el('select', 'scope-select');
    select.id = 'dependency-tree-scope'; select.title = 'Dependency tree scope'; select.setAttribute('aria-label', 'Dependency tree scope');
    select.append(...scopes.map(candidate => new Option(scopeKindLabel(candidate), scopeKey(candidate))));
    select.value = key;
    select.addEventListener('change', () => { dependencyScope = select.value; save(); render(); });
    toolbar.append(select);
  } else toolbar.append(el('span', 'muted', scopeKindLabel(scope)));
  const load = button(loaded ? 'Reload' : 'Load dependency tree', () => send({ type: 'dependencyTree', scopeKey: key }), loaded ? 'secondary' : '');
  load.id = 'dependency-tree-load'; load.disabled = !!tree?.loading;
  toolbar.append(load);
  if (loaded && !tree?.loading) {
    const text = button('Open as text', () => send({ type: 'dependencyTreeText', scopeKey: key }), 'secondary');
    text.id = 'dependency-tree-text'; text.title = 'Open the APM report in a read-only editor';
    toolbar.append(text);
  }
  content.append(toolbar);
  if (tree?.loading) {
    const status = el('p', 'muted', 'Loading dependency tree…'); status.setAttribute('role', 'status'); content.append(status);
  }
  if (tree?.error) content.append(el('p', 'notice warning', tree.error));
  if (tree?.root && tree.stale) content.append(el('p', 'notice warning', 'Installed packages changed after this tree was loaded. Reload it to see current dependencies.'));
  if (!tree?.root) {
    if (!tree) content.append(el('p', 'empty', `Load the tree to see how ${scopeKindLabel(scope).toLowerCase()} packages depend on each other. It runs apm deps tree for this scope.`));
    return;
  }
  const items = state.installed.filter(item => item.scope && scopeKey(item.scope) === key);
  const found = new Map<DependencyTreeNode, PackageItem | undefined>();
  const itemFor = (node: DependencyTreeNode) => {
    if (!node.packageName) return undefined;
    if (!found.has(node)) found.set(node, dependencyTreeItem(node.packageName, items));
    return found.get(node);
  };
  const marketplace = filterTokens(search).marketplace;
  const terms = (withStatus(search, '').match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).filter(term => !term.startsWith('@')).map(term => term.replaceAll('"', '').toLowerCase());
  const filtering = !!marketplace || terms.length > 0;
  const shown = new Map<DependencyTreeNode, boolean>();
  // A package stays visible when it or a descendant package matches; summary rows follow their parent.
  const visible = (node: DependencyTreeNode): boolean => {
    if (!node.packageName) return !filtering;
    if (!shown.has(node)) {
      const item = itemFor(node);
      const text = `${node.label} ${item?.name ?? ''} ${item?.description ?? ''} ${item ? marketplaceLabel(item) : ''}`.toLowerCase();
      shown.set(node, ((!marketplace || (!!item && marketplaceLabel(item) === marketplace)) && terms.every(term => text.includes(term))) ||
        node.children.some(child => !!child.packageName && visible(child)));
    }
    return shown.get(node)!;
  };
  const top = tree.root.children.filter(visible);
  if (!top.length) { content.append(el('p', 'empty', 'No dependencies match your filters.')); return; }
  const list = el('ul', 'dependency-tree');
  list.id = 'dependency-tree'; list.setAttribute('role', 'tree');
  list.setAttribute('aria-label', `Dependency tree: ${tree.root.label}`);
  const add = (parent: HTMLElement, nodes: DependencyTreeNode[], level: number, path: string) => nodes.forEach((node, index) => {
    const id = `dependency-tree-${path}${index}`, treeKey = `${key}|${id}`, item = itemFor(node);
    const children = node.children.filter(child => !child.packageName || visible(child));
    const expanded = children.length > 0 && !collapsedTree.has(treeKey);
    const entry = el('li', 'dependency-node');
    entry.id = id; entry.tabIndex = -1; entry.dataset.key = treeKey;
    entry.setAttribute('role', 'treeitem');
    entry.setAttribute('aria-level', String(level)); entry.setAttribute('aria-setsize', String(nodes.length)); entry.setAttribute('aria-posinset', String(index + 1));
    if (children.length) entry.setAttribute('aria-expanded', String(expanded));
    const row = el('div', `dependency-row${children.length && !expanded ? ' collapsed' : ''}`);
    row.style.paddingLeft = `${(level - 1) * 16 + 4}px`;
    const twistie = el('span', children.length ? 'twistie' : 'twistie-space'); twistie.setAttribute('aria-hidden', 'true');
    twistie.addEventListener('click', event => { event.stopPropagation(); toggleTreeItem(entry); });
    row.append(twistie);
    const name = item?.name ?? node.packageName;
    const version = node.version ?? item?.version;
    if (name) {
      row.append(el('strong', '', name));
      if (version) row.append(el('span', 'version', version));
      if (node.packageName && node.packageName !== name) row.append(el('span', 'dependency-key muted', node.packageName));
    } else row.append(el('span', 'muted', node.label));
    const note = node.note === 'circular' ? 'Circular' : node.note === 'unresolved' ? 'Not placed: run apm install' : undefined;
    if (note) row.append(badge(note));
    entry.setAttribute('aria-label', [name ?? node.label, version, note].filter(Boolean).join(', '));
    if (item) {
      entry.dataset.id = item.id; row.title = item.description ? `${item.description}\n\nOpen package details` : 'Open package details';
    }
    row.addEventListener('click', () => { focusTreeItem(entry); activateTreeItem(entry, key); });
    entry.append(row);
    if (expanded) {
      const group = el('ul'); group.setAttribute('role', 'group');
      add(group, children, level + 1, `${path}${index}-`);
      entry.append(group);
    }
    parent.append(entry);
  });
  add(list, top, 1, '');
  const treeItems = [...list.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  (treeItems.find(entry => entry.id === treeFocus) ?? treeItems[0]).tabIndex = 0;
  list.addEventListener('keydown', event => {
    const current = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="treeitem"]') : null;
    if (!current) return;
    const all = [...list.querySelectorAll<HTMLElement>('[role="treeitem"]')], index = all.indexOf(current);
    const expanded = current.getAttribute('aria-expanded');
    let target: HTMLElement | null | undefined;
    switch (event.key) {
      case 'ArrowDown': target = all[index + 1]; break;
      case 'ArrowUp': target = all[index - 1]; break;
      case 'Home': target = all[0]; break;
      case 'End': target = all.at(-1); break;
      case 'ArrowRight':
        if (expanded === 'false') toggleTreeItem(current);
        else if (expanded === 'true') target = current.querySelector<HTMLElement>('[role="treeitem"]');
        break;
      case 'ArrowLeft':
        if (expanded === 'true') toggleTreeItem(current);
        else target = current.parentElement?.closest<HTMLElement>('[role="treeitem"]');
        break;
      case 'Enter': case ' ': activateTreeItem(current, key); break;
      default: return;
    }
    event.preventDefault();
    if (target) focusTreeItem(target);
  });
  content.append(list);
}
function focusTreeItem(entry: HTMLElement) {
  for (const other of entry.closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []) other.tabIndex = -1;
  entry.tabIndex = 0; treeFocus = entry.id; entry.focus();
}
function toggleTreeItem(entry: HTMLElement) {
  const key = entry.dataset.key;
  if (!key || !entry.hasAttribute('aria-expanded')) return;
  if (!collapsedTree.delete(key)) collapsedTree.add(key);
  treeFocus = entry.id; entry.focus(); render();
}
function activateTreeItem(entry: HTMLElement, key: string) {
  if (entry.dataset.id) { galleryFocus = treeFocus = entry.id; send({ type: 'details', id: entry.dataset.id, scopeKey: key }); }
  else toggleTreeItem(entry);
}
function galleryFilterGroup(title: string, key: 'sort' | 'scope' | 'marketplace', options: { label: string; value: string; disabled?: boolean }[], current: string) {
  const group = el('fieldset', 'gallery-filter-group');
  group.id = `gallery-${key}`;
  group.append(el('legend', '', title));
  for (const option of options) {
    const label = el('label', 'gallery-filter-option');
    const input = el('input');
    input.type = 'radio'; input.name = `gallery-${key}`; input.id = `gallery-${key}-${encodeURIComponent(option.value)}`;
    input.value = option.value; input.checked = option.value === current; input.disabled = !!option.disabled;
    input.addEventListener('change', () => {
      if (input.checked) applySearch(withToken(search, `@${key}:`, key === 'sort' && input.value === 'name' ? '' : input.value));
    });
    label.append(input, el('span', '', option.label));
    group.append(label);
  }
  return group;
}
function galleryFilterPanel(section: GallerySection) {
  const panel = el('aside', 'gallery-filters');
  panel.setAttribute('aria-label', 'Package filters');
  panel.append(el('h2', '', 'Filters'));
  const tokens = filterTokens(search);
  const order = galleryFilterGroup('Order by', 'sort', [
    { label: 'Name (A-Z)', value: 'name' }, { label: 'Name (Z-A)', value: 'name-desc' }, { label: 'Marketplace', value: 'marketplace' }
  ], tokens.sort);
  order.disabled = section === 'dependencies' && dependencyView === 'tree';
  if (order.disabled) order.title = 'Dependency trees keep APM dependency order. Switch to List to sort packages.';
  panel.append(order);
  const folders = state.scopes.filter(scope => scope.kind === 'workspace');
  const scope = galleryFilterGroup('Scope', 'scope', [
    { label: 'All scopes', value: '' },
    { label: 'Workspace', value: 'workspace', disabled: !folders.length },
    { label: 'Global', value: 'global', disabled: !state.scopes.some(scope => scope.kind === 'global') }
  ], tokens.scope);
  if (folders.length > 1) {
    const label = el('label', 'gallery-workspace');
    label.append(el('span', '', 'Workspace folder'));
    const select = el('select'); select.id = 'gallery-workspace';
    select.append(...folders.map(folder => new Option(folder.label, scopeKey(folder))));
    select.value = scopeKey(folders.find(folder => scopeKey(folder) === state.scopeKey) ?? folders[0]);
    select.disabled = state.busy;
    select.addEventListener('change', () => send({ type: 'scope', key: select.value }));
    label.append(select); scope.append(label);
  }
  panel.append(scope);
  const names = [...new Set(state.marketplaces.map(marketplace => marketplace.name))].sort((a, b) => a.localeCompare(b));
  if (tokens.marketplace && !names.includes(tokens.marketplace)) names.push(tokens.marketplace);
  panel.append(galleryFilterGroup('Marketplace', 'marketplace', [
    { label: 'All marketplaces', value: '' }, ...names.map(name => ({ label: name, value: name }))
  ], tokens.marketplace));
  return panel;
}
function renderGalleryGroups(content: HTMLElement, section: GallerySection, groups: { key: BrowserSection; title: string; items: PackageItem[] }[], emptyNodes: () => HTMLElement[]) {
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  if (!total) {
    const empty = el('div', 'gallery-empty');
    empty.append(...emptyNodes());
    content.append(empty);
    return;
  }
  const key = `gallery:${section}`, limit = limits[key] ?? 200;
  let remaining = limit;
  groups.forEach((group, index) => {
    if (!group.items.length || remaining <= 0) return;
    const node = el('section', 'gallery-group');
    const heading = el('h2', 'gallery-group-heading');
    heading.id = `gallery-group-${index}`;
    heading.append(el('span', '', group.title), el('span', 'gallery-nav-count', String(group.items.length)));
    const list = el('ul', 'package-cards');
    list.setAttribute('role', 'list'); list.setAttribute('aria-labelledby', heading.id);
    for (const item of group.items.slice(0, remaining)) {
      const entry = el('li'); entry.append(packageCard(group.key, item)); list.append(entry);
    }
    remaining -= group.items.length;
    node.append(heading, list);
    content.append(node);
  });
  if (total > limit) content.append(button(`Show more (${total - limit} remaining)`, () => { limits[key] = limit + 200; save(); render(); }, 'secondary gallery-more'));
}
function packageCard(section: BrowserSection, item: PackageItem) {
  const card = button('', () => { galleryFocus = card.id; openPackage(item); }, 'package-card');
  card.id = `card-${section}-${item.scope ? `${scopeKey(item.scope)}-` : ''}${item.id}`;
  const title = el('span', 'package-title'); title.append(el('strong', '', item.name), el('span', 'version', item.version));
  card.append(title);
  if (!marketplaceLabel(item)) card.append(el('span', 'marketplace', origin(item)));
  card.append(item.description ? el('span', 'description', item.description) : el('span', 'description muted', 'No description'));
  if (item.direct === false && item.requiredBy?.length) card.append(el('span', 'required-by', requiredByText(item)));
  const tags = packageTags(section, item);
  if (tags) card.append(tags);
  return card;
}
function renderDetails(container: HTMLElement) {
  const item = state.item;
  if (!item) { container.append(el('p', '', 'Package details are loading...')); return; }
  const head = header(item.name, item.description);
  if (state.gallery) {
    const back = iconButton('Back to packages', 'back', () => send({ type: 'back' }), 'back-button');
    back.id = 'gallery-back'; back.disabled = state.actionResult?.status === 'running';
    head.prepend(back);
  }
  container.append(head, el('p', 'muted', `${origin(item)} • ${item.version}`));
  const installations = state.installed.filter(installation => samePackage(installation, item) && installation.scope);
  if (installations.length) {
    const scopes = el('div', 'toolbar installation-tags');
    scopes.setAttribute('role', 'group');
    scopes.setAttribute('aria-label', 'Package installations');
    for (const installation of installations) {
      const scope = installation.scope!;
      const key = scopeKey(scope);
      const tag = installationTag('details', installation,
        () => send({ type: 'details', id: installation.id, scopeKey: key }));
      if (tag) {
        tag.id = `installation-${key}`;
        tag.title = `${scopeKindLabel(scope)}: ${installation.version}`;
        tag.setAttribute('aria-pressed', String(key === state.scopeKey));
        scopes.append(tag);
      }
    }
    container.append(scopes);
  }
  container.append(dependencyRelation(item));
  const toolbar = el('div', 'toolbar');
  const global = state.scopeKey.startsWith('global:');
  if (item.installed) {
    if (item.updateStatus === 'outdated') toolbar.append(packageAction('Update', 'update'), packageAction('Preview update', 'previewUpdate', 'secondary'));
    toolbar.append(packageAction('Uninstall', 'uninstall', 'secondary'), packageAction('Change version…', 'installWithOptions', 'secondary'));
    if (!global) toolbar.append(packageAction('Audit', 'audit', 'secondary'));
    if (item.scope) toolbar.append(button('Explain dependency', () =>
      send({ type: 'dependencyWhy', id: item.id, scopeKey: scopeKey(item.scope!) }), 'secondary'));
    const scope = state.scopes.find(scope => `${scope.kind}:${scope.path}` === state.scopeKey);
    const dependencies = button(scope?.kind === 'global' ? 'View global dependencies' : 'View workspace dependencies', () => {
      // The package browser window shows dependencies on its own page instead of the sidebar.
      if (state.gallery) { dependencyScope = state.scopeKey; selectGallerySection('dependencies'); }
      else send({ type: 'dependencies' });
    }, 'secondary');
    dependencies.title = 'Shows all installed dependencies in this scope.';
    toolbar.append(dependencies);
    toolbar.append(packageAction('Install in…', 'install', 'secondary'));
  } else toolbar.append(packageAction('Install', 'install'), packageAction('Install version…', 'installWithOptions', 'secondary'));
  toolbar.append(packageAction('Preview install', 'previewInstall', 'secondary'), packageAction('Preview version…', 'previewWithOptions', 'secondary'));
  if (state.actionResult?.preview && state.actionResult.status === 'success') toolbar.append(packageAction('Review and apply preview options', 'applyPreview'));
  container.append(toolbar);
  if (state.actionResult) container.append(renderActionResult(state.actionResult, () => send({ type: 'cancel' }), id => send({ type: 'navigate', id })));
  const updateKind = item.updateStatus === 'outdated'
    ? versionUpdateKind(item.version, item.latestVersion) : undefined;
  const updateLabel = updateKind && updateKind !== 'available'
    ? `${updateKind[0].toUpperCase()}${updateKind.slice(1)} update available` : 'Update available';
  const updateMessage = item.updateStatus === 'outdated'
    ? `${updateLabel}${item.latestVersion ? `: ${item.version} → ${item.latestVersion}` : ''}.${updateKind === 'major' ? ' This may include incompatible changes; review release notes before updating.'
      : updateKind === 'available' ? ' Review release notes to understand the changes.'
        : ' SemVer describes the version bump, not the exact release contents; review release notes for details.'}${item.updateStale ? ' This is the last known result; refresh to verify.' : ''}`
    : item.updateStatus === 'current' ? 'This package is up to date.'
      : item.updateStatus === 'failed' || item.updateStatus === 'unknown'
        ? `Could not check for updates${item.updateStale ? '; showing the last known result' : ''}.`
        : item.updateStatus === 'not-comparable' ? 'Could not compare this package version with the latest version.'
          : item.updateStatus === 'unchecked' ? 'Update status has not been checked yet.' : undefined;
  if (updateMessage) container.append(el('p', `notice${item.updateStale || updateKind === 'major' ? ' warning' : ''}`, updateMessage));
  container.append(renderDetailSections(item, state.details, state.busy, id => send({ type: 'navigate', id })));
  if (state.readmeHtml) {
    const article = el('article', 'readme'); article.innerHTML = state.readmeHtml; container.append(article);
  } else container.append(el('p', 'muted', state.busy ? 'Loading README...' : 'README is not available from this source.'));
}
function dependencyRelation(item: PackageItem) {
  const node = el('p', 'muted dependency-relation');
  if (item.direct !== false) { node.textContent = item.installed ? 'Direct dependency' : 'Not installed in this scope'; return node; }
  node.append('Transitive dependency');
  if (item.requiredBy?.length) {
    node.append(' required by ');
    item.requiredBy.forEach((parent, index) => {
      if (index) node.append(', ');
      const parentScope = item.scope;
      if (parent.id && parentScope) {
        const link = button(parent.name, () => send({ type: 'details', id: parent.id!, scopeKey: scopeKey(parentScope) }), 'link-button');
        link.title = `Open ${parent.name} details`;
        node.append(link);
      } else node.append(el('strong', '', parent.name));
    });
  }
  node.append(' — update its parent to change the pin.');
  return node;
}
root.addEventListener('click', event => {
  const link = event.target instanceof Element ? event.target.closest('a') : null;
  if (link) { event.preventDefault(); if (link.href) send({ type: 'external', url: link.href }); }
});
let filtersReported = false;
const sharesSearch = (value?: State) => value?.mode === 'browser' || !!value?.gallery;
window.addEventListener('message', (event: MessageEvent<{ type: string; state?: State; search?: string }>) => {
  if (event.data?.type === 'setSearch' && typeof event.data.search === 'string' && sharesSearch(state)) { applySearch(event.data.search); return; }
  if (event.data?.type !== 'state' || !event.data.state) return;
  if (sharesSearch(event.data.state) && event.data.state.browserSearch !== undefined) {
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
