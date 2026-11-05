import type { State, Message } from '../protocol';
import type { PackageItem } from '../apm/types';
import type { PackageAction } from '../apm/actions';
import { renderActionResult, renderDetailSections } from './details';
import { filterPackages, type Filters } from './filter';

declare function acquireVsCodeApi(): { postMessage(message: Message): void; getState(): unknown; setState(value: unknown): void };
const api = acquireVsCodeApi();
const root = document.getElementById('app')!;
type Saved = { search?: string; collapsed?: string[]; limit?: Record<string, number>; selected?: string };
const saved = api.getState() as Saved | undefined;
let state: State;
let selected = saved?.selected ?? 'install';
let search = saved?.search ?? '';
const collapsed = new Set(saved?.collapsed ?? []);
let limits: Record<string, number> = saved?.limit ?? {};
const drafts = new Map<string, { args: Record<string, string>; options: Record<string, unknown> }>();
let lastCommandRequest: number | undefined;
const send = (message: Message) => api.postMessage(message);
function save() { api.setState({ search, collapsed: [...collapsed], limit: limits, selected }); }
const codicons = {
  chevronDown: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M3.14598 5.85423L7.64598 10.3542C7.84098 10.5492 8.15798 10.5492 8.35298 10.3542L12.853 5.85423C13.048 5.65923 13.048 5.34223 12.853 5.14723C12.658 4.95223 12.341 4.95223 12.146 5.14723L7.99998 9.29323L3.85398 5.14723C3.65898 4.95223 3.34198 4.95223 3.14698 5.14723C2.95198 5.34223 2.95098 5.65923 3.14598 5.85423Z"/></svg>',
  chevronRight: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M6.14601 3.14579C5.95101 3.34079 5.95101 3.65779 6.14601 3.85279L10.292 7.99879L6.14601 12.1448C5.95101 12.3398 5.95101 12.6568 6.14601 12.8518C6.34101 13.0468 6.65801 13.0468 6.85301 12.8518L11.353 8.35179C11.548 8.15679 11.548 7.83979 11.353 7.64478L6.85301 3.14479C6.65801 2.94979 6.34101 2.95079 6.14601 3.14579Z"/></svg>',
  clearAll: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M13.5004 12.0004C13.7762 12.0006 14.0004 12.2245 14.0004 12.5004C14.0002 12.7761 13.7761 13.0002 13.5004 13.0004H2.50037C2.22449 13.0004 2.00056 12.7762 2.00037 12.5004C2.00037 12.2244 2.22437 12.0004 2.50037 12.0004H13.5004Z"/><path d="M13.5004 9.00037C13.7762 9.00056 14.0004 9.22449 14.0004 9.50037C14.0002 9.77608 13.7761 10.0002 13.5004 10.0004H2.50037C2.22449 10.0004 2.00056 9.7762 2.00037 9.50037C2.00037 9.22437 2.22437 9.00037 2.50037 9.00037H13.5004Z"/><path d="M13.5004 6.00037C13.7762 6.00056 14.0004 6.22449 14.0004 6.50037C14.0002 6.77608 13.7761 7.00017 13.5004 7.00037H7.50037C7.22449 7.00037 7.00056 6.7762 7.00037 6.50037C7.00037 6.22437 7.22437 6.00037 7.50037 6.00037H13.5004Z"/><path d="M5.50037 0.999023C5.63295 0.999115 5.76009 1.05179 5.85388 1.14551C5.94777 1.23939 6.00037 1.36722 6.00037 1.5C6.00027 1.63265 5.94769 1.75971 5.85388 1.85352L3.7074 4L5.85388 6.14551C5.94777 6.23939 6.00037 6.36722 6.00037 6.5C6.00027 6.63265 5.94769 6.75971 5.85388 6.85352C5.76008 6.94732 5.63302 6.99991 5.50037 7C5.36759 7 5.23976 6.9474 5.14587 6.85352L3.00037 4.70703L0.853882 6.85352C0.760077 6.94732 0.633017 6.99991 0.500366 7C0.36759 7 0.239761 6.9474 0.145874 6.85352C0.0521583 6.75972 -0.000519052 6.63258 -0.000610352 6.5C-0.000610354 6.36722 0.0519875 6.23939 0.145874 6.14551L2.29333 4L0.145874 1.85352C0.0521583 1.75972 -0.000519119 1.63258 -0.000610352 1.5C-0.000610351 1.36722 0.0519874 1.23939 0.145874 1.14551C0.239761 1.05162 0.36759 0.999023 0.500366 0.999023C0.63295 0.999115 0.76009 1.05179 0.853882 1.14551L3.00037 3.29297L5.14587 1.14551C5.23976 1.05162 5.36759 0.999023 5.50037 0.999023Z"/><path d="M13.5004 3.00037C13.7762 3.00056 14.0004 3.22449 14.0004 3.50037C14.0002 3.77608 13.7761 4.00017 13.5004 4.00037H7.50037C7.22449 4.00037 7.00056 3.7762 7.00037 3.50037C7.00037 3.22437 7.22437 3.00037 7.50037 3.00037H13.5004Z"/></svg>',
  filter: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M9.5 14H6.5C6.224 14 6 13.776 6 13.5V9.329C6 8.928 5.844 8.552 5.561 8.268L1.561 4.268C1.205 3.911 1 3.418 1 2.914C1 1.858 1.858 1 2.914 1H13.086C14.142 1 15 1.858 15 2.914C15 3.417 14.796 3.911 14.439 4.267L10.439 8.267C10.156 8.551 10 8.927 10 9.328V13.499C10 13.775 9.776 13.999 9.5 13.999V14ZM7 13H9V9.329C9 8.661 9.26 8.033 9.732 7.561L13.732 3.561C13.902 3.391 14 3.155 14 2.915C14 2.411 13.59 2.001 13.086 2.001H2.914C2.41 2.001 2 2.411 2 2.915C2 3.155 2.098 3.391 2.268 3.562L6.268 7.562C6.741 8.034 7 8.662 7 9.33V13.001V13Z"/></svg>',
};
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
}
function button(text: string, action: (event: MouseEvent) => void, className = '') {
  const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node;
}
function action(text: string, type: 'refresh' | 'tools' | 'marketplaces' | 'setup' | 'output' | 'settings' | 'cancel') {
  return button(text, () => send({ type }));
}
function selectField(label: string, entries: [string, string][], value: string, change: (value: string) => void) {
  const wrapper = el('label', 'field'); wrapper.append(el('span', '', label));
  const select = el('select'); select.setAttribute('aria-label', label);
  for (const [id, text] of entries) { const option = el('option', '', text); option.value = id; select.append(option); }
  select.value = value; select.addEventListener('change', () => change(select.value)); wrapper.append(select); return wrapper;
}
function badge(text: string, warning = false) { return el('span', warning ? 'badge warning' : 'badge', text); }
function packageAction(text: string, name: PackageAction, className = '') {
  const node = button(text, () => send({ type: 'packageAction', action: name }), className);
  node.disabled = state.actionResult?.status === 'running' || !state.trusted || !state.version;
  return node;
}
function header(title: string, subtitle?: string) {
  const node = el('header', 'page-header'); node.append(el('h1', '', title));
  if (subtitle) node.append(el('p', 'muted', subtitle));
  return node;
}
function notifications() {
  const node = el('div', 'notifications');
  if (!state.trusted) {
    const warning = el('div', 'notice warning'); warning.append(el('p', '', 'Workspace Trust is required to run APM and read package sources.'), button('Manage Workspace Trust', () => send({ type: 'trust' }))); node.append(warning);
  }
  if (state.warning && state.mode === 'browser') {
    const update = el('div', 'notice'); update.append(el('p', '', state.warning), action('Update APM', 'setup')); node.append(update);
  }
  if (state.error) { const error = el('div', 'notice error'); error.setAttribute('role', 'alert'); error.append(el('p', '', state.error), action('Show Output', 'output')); node.append(error); }
  for (const message of state.errors) node.append(el('p', 'notice error', message));
  if (!state.version && state.trusted && !state.busy) node.append(action('Install / locate APM CLI', 'setup'));
  if (state.busy) { const busy = el('p', 'progress', 'APM is working...'); busy.setAttribute('role', 'status'); node.append(busy); }
  return node;
}
function render() {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.id : '';
  const selection = document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'text' ? document.activeElement.selectionStart : null;
  root.replaceChildren();
  root.className = state.mode === 'browser' ? 'sidebar' : 'editor';
  if (state.mode === 'browser') renderBrowser();
  else {
    root.append(notifications());
    if (state.mode === 'tools') renderTools();
    else renderDetails();
  }
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
  renderLists(); reportFilters();
}
function reportFilters() { send({ type: 'filters', search }); }
function renderBrowser() {
  const controls = el('div', 'sidebar-controls');
  const searchbar = el('div', 'searchbar');
  const input = el('input'); input.type = 'text'; input.id = 'search'; input.placeholder = 'Search packages or @filters'; input.title = 'Search by name or description. Filters: @marketplace:<name>, @installed, @updates, @sort:<order>.'; input.setAttribute('aria-label', 'Filter packages by text or use @marketplace:<name>, @installed, @updates, or @sort:<order>'); input.value = search;
  input.addEventListener('input', () => { search = input.value; clear.disabled = !search; limits = {}; save(); renderLists(); reportFilters(); });
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
  if (state.busy) { const toolbar = el('div', 'toolbar compact'); toolbar.append(action('Cancel refresh', 'cancel')); controls.append(toolbar); }
  root.append(controls, notifications(), el('div', 'sections'));
  renderLists();
  const footer = el('footer', 'muted');
  footer.append(el('span', '', state.version ? `APM ${state.version}` : 'APM CLI not connected'));
  if (state.checkedAt) footer.append(el('span', '', `Updates checked ${new Date(state.checkedAt).toLocaleString()}`));
  footer.append(action('CLI setup / upgrade', 'setup')); root.append(footer);
}
function renderLists() {
  const sections = root.querySelector('.sections'); if (!sections) return;
  sections.replaceChildren();
  const rows: [string, PackageItem[]][] = [
    ['Catalog', state.catalog],
    ['Installed', state.installed],
    ['Updates', state.installed.filter(item => item.updateStatus === 'outdated')]
  ];
  for (const [name, items] of rows) {
    const visible = filterPackages(items, filters());
    const section = el('section', 'package-section');
    const heading = button('', () => { if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name); save(); renderLists(); }, 'section-heading');
    const twistie = el('span', 'twistie'); twistie.innerHTML = collapsed.has(name) ? codicons.chevronRight : codicons.chevronDown;
    heading.setAttribute('aria-expanded', String(!collapsed.has(name)));
    heading.append(twistie, el('span', 'section-title', name), el('span', 'count-badge', String(visible.length))); section.append(heading);
    if (!collapsed.has(name)) {
      if (!visible.length) {
        const updateError = state.errors.some(error => error.startsWith('Updates:'));
        const uncertainUpdates = state.installed.some(item =>
          ['unchecked', 'unknown', 'failed'].includes(item.updateStatus ?? '') || item.updateStale
        );
        const incomparableUpdates = state.installed.some(item => item.updateStatus === 'not-comparable');
        const text = name === 'Catalog' && !state.marketplaces.length ? 'No marketplaces registered.' :
          search ? 'No packages match your filters.' :
            name === 'Updates' ? !state.installed.length ? 'No installed packages to check for updates.' :
              state.busy ? 'Checking for updates…' :
                updateError ? 'Could not check for updates. See APM Output for details.' :
                  uncertainUpdates ? 'No updates found, but some packages could not be checked.' :
                    incomparableUpdates ? 'No updates found, but some package versions could not be compared.' :
                      'All installed packages are up to date.' :
              'No packages found.';
        section.append(el('p', 'empty', text));
        if (name === 'Updates' && updateError && !search) section.append(action('Show APM Output', 'output'));
        if (name === 'Catalog' && !state.marketplaces.length) section.append(action('Add marketplace', 'marketplaces'));
      }
      const limit = limits[name] ?? 100;
      const list = el('div', 'package-list'); list.setAttribute('role', 'list');
      for (const item of visible.slice(0, limit)) {
        const wrapper = el('div'); wrapper.setAttribute('role', 'listitem');
        const row = button('', () => send({ type: 'details', id: item.id }), 'package-row');
        const content = el('span', 'package-content');
        const title = el('span', 'package-title'); title.append(el('strong', '', item.name), el('span', 'version', item.version));
        content.append(title);
        if (item.description) content.append(el('span', 'description', item.description));
        content.append(el('span', 'marketplace', item.marketplace || item.source || 'Direct source'));
        const tags = el('span', 'tags');
        if (item.updateStatus === 'outdated') {
          if (name === 'Updates') {
            if (item.updateStale) tags.append(badge('Cached'));
          } else tags.append(badge(item.updateStale ? 'Update available (cached)' : 'Update available', true));
        } else if (item.updateStale) tags.append(badge('Showing saved update status'));
        else if (item.updateStatus === 'failed' || item.updateStatus === 'unknown') tags.append(badge('Could not check for updates'));
        else if (item.updateStatus === 'not-comparable') tags.append(badge('Version could not be compared'));
        else if (item.updateStatus === 'unchecked') tags.append(badge('Update status not checked'));
        if (item.metadata?.stale) tags.append(badge('Cached catalog'));
        if (item.direct === false) tags.append(badge('Transitive'));
        if (name === 'Catalog' && item.installed) tags.append(badge('Installed'));
        if (tags.childElementCount) content.append(tags);
        row.append(content); wrapper.append(row); list.append(wrapper);
      }
      section.append(list);
      if (visible.length > limit) section.append(button(`Show more (${visible.length - limit} remaining)`, () => { limits[name] = limit + 100; save(); renderLists(); }, 'secondary'));
    }
    sections.append(section);
  }
}
function renderDetails() {
  const item = state.item;
  if (!item) { root.append(el('p', '', 'Package details are loading...')); return; }
  root.append(header(item.name, item.description), el('p', 'muted', `${item.marketplace || item.source || 'Direct source'} • ${item.version}`));
  const toolbar = el('div', 'toolbar');
  const global = state.scopeKey.startsWith('global:');
  if (item.installed) {
    if (item.updateStatus === 'outdated') toolbar.append(packageAction('Update', 'update'));
    toolbar.append(packageAction('Uninstall', 'uninstall', 'secondary'), packageAction('Change version / target…', 'installWithOptions', 'secondary'));
    if (!global) toolbar.append(packageAction('Audit', 'audit', 'secondary'));
    toolbar.append(packageAction('Dependency tree', 'tree', 'secondary'));
  } else toolbar.append(packageAction('Install', 'install'), packageAction('Install version / target…', 'installWithOptions', 'secondary'));
  root.append(toolbar);
  if (state.actionResult) root.append(renderActionResult(state.actionResult, () => send({ type: 'cancel' })));
  const scopeLabel = state.scopes.find(s => `${s.kind}:${s.path}` === state.scopeKey)?.label;
  const updateMessage = item.updateStatus === 'outdated'
    ? `Update available${item.latestVersion ? `: ${item.latestVersion}` : ''}.${item.updateStale ? ' This is the last known result; refresh to verify.' : ''}`
    : item.updateStatus === 'current' ? 'This package is up to date.'
      : item.updateStatus === 'failed' || item.updateStatus === 'unknown'
        ? `Could not check for updates${item.updateStale ? '; showing the last known result' : ''}.`
        : item.updateStatus === 'not-comparable' ? 'Could not compare this package version with the latest version.'
          : item.updateStatus === 'unchecked' ? 'Update status has not been checked yet.' : undefined;
  if (updateMessage) root.append(el('p', `notice${item.updateStale ? ' warning' : ''}`, `${updateMessage}${scopeLabel ? ` Scope: ${scopeLabel}.` : ''}`));
  root.append(renderDetailSections(item, state.details, state.busy));
  if (state.readmeImagesBlocked?.https || state.readmeImagesBlocked?.insecure) {
    const notice = el('div', 'notice');
    if (state.readmeImagesBlocked.https) {
      notice.append(el('p', '', 'Remote README images are blocked for privacy. You can allow HTTPS images in VS Code Settings.'),
        button('Open Image Settings', () => send({ type: 'readmeImageSettings' }), 'secondary'));
    }
    if (state.readmeImagesBlocked.insecure) notice.append(el('p', '', 'Images with insecure HTTP or protocol-relative URLs are always blocked.'));
    root.append(notice);
  }
  if (state.readmeHtml) {
    const article = el('article', 'readme'); article.innerHTML = state.readmeHtml; root.append(article);
  } else root.append(el('p', 'muted', state.busy ? 'Loading README...' : 'README is not available from this source.'));
}
function rememberDraft() {
  const form = root.querySelector<HTMLFormElement>('#command-form');
  if (!form) return;
  const args: Record<string, string> = {}, options: Record<string, unknown> = {};
  for (const input of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-kind]')) {
    const key = input.dataset.key!;
    if (input.dataset.kind === 'flagOnly') {
      if (input instanceof HTMLInputElement && input.checked) options[key] = true;
      continue;
    }
    if (input.dataset.kind === 'argument') args[key] = input.value;
    else if (input.value !== '') options[key] = input.dataset.type === 'boolean' ? input.value === 'true' : input.value;
  }
  drafts.set(`${state.scopeKey}:${selected}`, { args, options });
}
function renderTools() {
  root.append(header('APM Tools', 'Visual workflows for the complete APM command set. Review scope and options before running.'));
  const scope = selectField('Execution scope', state.scopes.map(s => [`${s.kind}:${s.path}`, `${s.label} — ${s.path}`]), state.scopeKey, key => send({ type: 'scope', key }));
  root.append(scope);
  const selector = el('select'); selector.id = 'command-selector'; selector.setAttribute('aria-label', 'APM command');
  for (const category of [...new Set(state.commands.map(c => c.category))]) {
    const group = el('optgroup'); group.label = category;
    for (const descriptor of state.commands.filter(c => c.category === category)) {
      const option = el('option', '', `${descriptor.label}${descriptor.experimental ? ' (experimental)' : ''}${descriptor.deprecated ? ' (deprecated)' : ''}`);
      option.value = descriptor.id;
      if (state.availableCommands.length && !state.availableCommands.includes(descriptor.command[0])) { option.disabled = true; option.textContent += ' — unavailable'; }
      group.append(option);
    }
    selector.append(group);
  }
  if (!state.commands.some(c => c.id === selected)) selected = state.commands[0]?.id ?? '';
  selector.value = selected;
  selector.addEventListener('change', () => { rememberDraft(); selected = selector.value; save(); render(); });
  root.append(selector);
  const descriptor = state.commands.find(c => c.id === selected);
  if (!descriptor) return;
  root.append(el('p', 'command-description', descriptor.description));
  if (descriptor.experimental || descriptor.deprecated) root.append(el('p', 'notice warning', `${descriptor.experimental ? 'Experimental: enable the appropriate APM feature first. ' : ''}${descriptor.deprecated ? 'Deprecated by APM; prefer the replacement workflow. ' : ''}`));
  const scopeValue = state.scopes.find(s => `${s.kind}:${s.path}` === state.scopeKey);
  if (scopeValue?.kind === 'global') root.append(el('p', 'notice', descriptor.global ? 'Global mode is applied automatically for this command.' : 'This command has no --global flag. It runs in the host home directory, or is blocked if it requires a workspace.'));
  const draft = drafts.get(`${state.scopeKey}:${selected}`) ?? { args: {}, options: {} };
  const form = el('form'); form.id = 'command-form';
  if (descriptor.positionals.length) form.append(el('h2', '', 'Arguments'));
  for (const argument of descriptor.positionals) {
    const label = el('label', 'field'); label.append(el('span', '', `${argument.label}${argument.required ? ' *' : ''}${argument.variadic ? ' (one per line)' : ''}`));
    const input = argument.variadic ? el('textarea') : el('input');
    input.id = `arg-${argument.name}`; input.dataset.key = argument.name; input.dataset.kind = 'argument';
    input.value = draft.args[argument.name] ?? ''; input.required = argument.required;
    label.append(input); form.append(label);
  }
  const advanced = el('details', 'advanced'); advanced.open = descriptor.positionals.length === 0;
  advanced.append(el('summary', '', `Options (${descriptor.options.length})`));
  for (const option of descriptor.options) {
    const label = el('label', 'field'); label.append(el('span', '', `${option.name}${option.required ? ' *' : ''}`));
    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (option.type === 'boolean' || option.choices) {
      const select = el('select');
      const entries: [string, string][] = option.type === 'boolean' ? [['', `Default${option.default !== undefined ? ` (${option.default})` : ''}`], ['true', 'Enabled'], ...(option.negative ? [['false', 'Disabled'] as [string, string]] : [])] : [['', 'Use default'], ...(option.choices ?? []).map(c => [c, c] as [string, string])];
      for (const [value, text] of entries) { const node = el('option', '', text); node.value = value; select.append(node); }
      input = select;
    } else {
      input = option.repeatable ? el('textarea') : el('input');
      if (input instanceof HTMLInputElement) input.type = option.type === 'number' ? 'number' : 'text';
      input.placeholder = option.repeatable ? 'One occurrence per line' : option.default !== undefined ? `Default: ${option.default}` : '';
    }
    input.id = `option-${option.name}`; input.dataset.kind = 'option'; input.dataset.key = option.name; input.dataset.type = option.type;
    input.value = draft.options[option.name] !== undefined && !(option.optionalValue && draft.options[option.name] === true) ? String(draft.options[option.name]) : '';
    if (option.name === '--global') { input.value = scopeValue?.kind === 'global' ? 'true' : ''; input.disabled = true; }
    label.append(input);
    if (option.optionalValue) {
      const flagLabel = el('div', 'checkbox');
      const flag = el('input'); flag.type = 'checkbox'; flag.dataset.kind = 'flagOnly'; flag.dataset.key = option.name;
      flag.setAttribute('aria-label', `${option.name} without a value`);
      flag.checked = draft.options[option.name] === true; input.disabled = flag.checked;
      flag.addEventListener('change', () => { input.disabled = flag.checked; });
      flagLabel.append(flag, el('span', '', 'Pass flag without a value (CLI default)')); label.append(flagLabel);
    }
    if (option.description) label.append(el('small', 'muted', option.description));
    if (option.repeatable) label.append(el('small', 'muted', 'One occurrence per line.'));
    if ((option.nargs ?? 1) > 1) label.append(el('small', 'muted', `${option.nargs} tab-separated values per occurrence.`));
    advanced.append(label);
  }
  form.append(advanced);
  const controls = el('div', 'toolbar');
  const run = button('Review and run', () => { rememberDraft(); const draft = drafts.get(`${state.scopeKey}:${selected}`)!; send({ type: 'command', id: selected, ...draft }); });
  run.disabled = state.busy || !state.trusted || !state.version;
  controls.append(run, button('Command help', () => send({ type: 'help', id: selected })), action('Show Output', 'output'));
  if (state.busy) controls.append(action('Cancel', 'cancel'));
  form.append(controls); form.addEventListener('submit', event => { event.preventDefault(); if (!run.disabled) run.click(); });
  form.addEventListener('input', rememberDraft); form.addEventListener('change', rememberDraft); root.append(form);
  root.append(el('p', 'muted', `${state.commands.length} command workflows. Root verbosity and --help are available through Command help and command options. Unsupported CLI flags are checked before execution.`));
  if (state.result) {
    const result = el('section', 'action-result command-result');
    result.setAttribute('aria-live', 'polite');
    result.setAttribute('aria-busy', String(state.busy));
    const heading = el('div', 'action-result-heading');
    heading.append(el('h2', '', 'Command result'), el('span', 'badge', state.busy ? 'Running' : 'Finished'));
    result.append(heading);
    const exitCode = state.result.match(/^Exit code: (-?\d+)/)?.[1];
    if (exitCode !== undefined) result.append(el('p', 'action-summary', `Exit code: ${exitCode}`));
    if (state.busy) result.append(el('p', 'muted', 'Live progress is available in the APM output channel.'));
    const output = el('details', 'action-output');
    output.open = state.busy || !!state.error;
    output.append(el('summary', '', 'Command output'), el('pre', 'result', state.result));
    result.append(output);
    root.append(result);
  }
}
root.addEventListener('click', event => {
  const link = event.target instanceof Element ? event.target.closest('a') : null;
  if (link) { event.preventDefault(); if (link.href) send({ type: 'external', url: link.href }); }
});
let filtersReported = false;
window.addEventListener('message', (event: MessageEvent<{ type: string; state?: State; search?: string }>) => {
  if (event.data?.type === 'setSearch' && typeof event.data.search === 'string' && state?.mode === 'browser') { applySearch(event.data.search); return; }
  if (event.data?.type !== 'state' || !event.data.state) return;
  if (event.data.state.mode === 'browser' && !filtersReported) { filtersReported = true; send({ type: 'filters', search }); }
  if (state?.mode === 'tools') rememberDraft();
  state = event.data.state;
  if (state.selectedCommand && state.commandRequest !== lastCommandRequest) {
    selected = state.selectedCommand;
    if (state.commandArgs || state.commandOptions) {
      const key = `${state.scopeKey}:${selected}`;
      drafts.set(key, { args: state.commandArgs ?? {}, options: state.commandOptions ?? {} });
    }
    lastCommandRequest = state.commandRequest;
  }
  render();
});
send({ type: 'ready' });
