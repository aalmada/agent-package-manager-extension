import * as vscode from 'vscode';
import { basename } from 'node:path';
import { isMap, isNode, isScalar, isSeq, parseDocument, stringify } from 'yaml';
import { descriptors } from './apm/commands';
import { containsUrlCredentials } from './apm/redact';
import { parseTargets } from './apm/actions';
import { yamlCompletion, yamlDefinition, yamlHover, yamlIssues } from './apm/yamlAssistance';
import packageManifest from '../package.json';

export const manifestFields: Record<string, string> = Object.fromEntries(
  Object.entries(yamlDefinition(false).fields ?? {}).map(([name, field]) => [name, field.description]));
export function manifestContext(text: string) {
  const document = parseDocument(text);
  return { document, schema: document.get('$schema'), errors: document.errors };
}
function targetOptions(): string[] {
  const option = descriptors.find(command => command.id === 'install')?.options.find(option => option.name === '--target');
  const documented = parseTargets(`--target ${option?.description ?? ''}`);
  return option?.choices ?? (documented.length ? documented : packageManifest.contributes.configuration.flatMap(group => group.properties['apm.config.target']?.items.enum ?? []));
}
function manifestTargets(yaml: ReturnType<typeof parseDocument>) {
  if (!isMap(yaml.contents)) return;
  const target = yaml.contents.items.find(pair => isScalar(pair.key) && pair.key.value === 'targets');
  if (!target || !isScalar(target.key) || !target.key.range || !isSeq(target.value)) return;
  return { key: target.key, value: target.value };
}
export function registerManifestAssistance(callbacks: { details(dependency: string, uri: vscode.Uri): Promise<void> }): vscode.Disposable {
  const selector: vscode.DocumentSelector = { scheme: 'file', language: 'yaml', pattern: '**/apm.yml' };
  const yamlSelector: vscode.DocumentSelector = [
    { scheme: 'file', language: 'yaml', pattern: '**/apm.yml' },
    { scheme: 'file', language: 'yaml', pattern: '**/apm.lock.yaml' }
  ];
  const registrations: vscode.Disposable[] = [];
  const safeYaml = (document: vscode.TextDocument) => vscode.workspace.isTrusted && document.uri.scheme === 'file'
    && ['apm.yml', 'apm.lock.yaml'].includes(basename(document.uri.fsPath)) && document.getText().length <= 1024 * 1024;
  const safe = (document: vscode.TextDocument) => safeYaml(document) && basename(document.uri.fsPath) === 'apm.yml';
  const definition = (document: vscode.TextDocument) => yamlDefinition(basename(document.uri.fsPath) === 'apm.lock.yaml', targetOptions());
  const validManifest = (document: vscode.TextDocument) => {
    if (!safe(document)) return;
    const { document: yaml, errors } = manifestContext(document.getText());
    return errors.length ? undefined : yaml;
  };
  registrations.push(vscode.languages.registerCompletionItemProvider(yamlSelector, {
    provideCompletionItems(document, position) {
      if (!safeYaml(document)) return [];
      const context = manifestContext(document.getText());
      const hasYaml = vscode.extensions.getExtension('redhat.vscode-yaml')?.isActive;
      if (hasYaml && typeof context.schema === 'string') return [];
      const offset = document.offsetAt(position);
      const completion = yamlCompletion(document.getText(), offset, definition(document));
      if (!completion || offset < completion.start || offset > completion.end) return [];
      const range = new vscode.Range(document.positionAt(completion.start), document.positionAt(completion.end));
      if (!completion.keys) {
        const values = completion.field.values ?? (completion.field.types?.includes('boolean') ? ['true', 'false'] : []);
        const text = document.getText(), quote = text[completion.start - 1];
        const unquote = completion.field.types?.length === 1 && completion.field.types[0] === 'boolean' && (quote === '"' || quote === "'");
        return values.map(value => {
          const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.EnumMember);
          item.documentation = completion.field.description; item.range = range;
          if (unquote) {
            item.range = new vscode.Range(document.positionAt(completion.start - 1), document.positionAt(completion.end + (text[completion.end] === quote ? 1 : 0)));
            item.filterText = `${quote}${value}${quote}`;
          }
          return item;
        });
      }
      const prefix = document.getText().slice(completion.start, offset).toLowerCase();
      return Object.entries(completion.field.fields ?? {}).filter(([field]) => !completion.keys?.includes(field) && field.toLowerCase().startsWith(prefix)).map(([field, hint]) => {
        const item = new vscode.CompletionItem(field, vscode.CompletionItemKind.Property);
        item.detail = basename(document.uri.fsPath); item.documentation = hint.description; item.range = range;
        const inline = document.lineAt(position.line).text.slice(0, position.character).includes('{');
        const suffix = completion.hasColon ? '' : !inline && hint.types?.length === 1 && hint.types[0] === 'mapping'
          ? ':\n  $0' : !inline && hint.types?.length === 1 && hint.types[0] === 'sequence' ? ':\n  - $0' : ': ${1}';
        item.insertText = new vscode.SnippetString(`${field}${suffix}`);
        return item;
      });
    }
  }, ':', '-', ' ', '"', "'", '{', '[', ','));
  registrations.push(vscode.languages.registerHoverProvider(yamlSelector, {
    provideHover(document, position) {
      if (!safeYaml(document)) return;
      const context = manifestContext(document.getText());
      const offset = document.offsetAt(position);
      const hover = yamlHover(context.document, offset, definition(document));
      if (!hover) return;
      const isSchemaField = document.getText().slice(hover.start, hover.end) === '$schema';
      const note = isSchemaField
        ? typeof context.schema === 'string'
          ? 'Explicit contract: inspect the selected schema and CLI support.'
          : 'Local APM working-draft assistance, not complete CLI validation.'
        : undefined;
      const contents = note ? `${hover.field.description}\n\n${note}` : hover.field.description;
      return new vscode.Hover(contents, new vscode.Range(document.positionAt(hover.start), document.positionAt(hover.end)));
    }
  }));
  registrations.push(vscode.languages.registerCodeLensProvider(selector, {
    provideCodeLenses(document) {
      const yaml = validManifest(document);
      if (!yaml) return [];
      const target = manifestTargets(yaml);
      if (!target?.key.range) return [];
      const selectedCount = target.value.items.filter(item => isScalar(item) && typeof item.value === 'string').length;
      const position = document.positionAt(target.key.range[0]);
      const lens = new vscode.CodeLens(new vscode.Range(position.line, position.character, position.line, position.character));
      lens.command = {
        title: `Select deployment targets (${selectedCount} selected)`,
        command: 'apm.selectManifestTargets',
        arguments: [document.uri]
      };
      return [lens];
    }
  }));
  registrations.push(vscode.commands.registerCommand('apm.selectManifestTargets', async (uri: unknown) => {
    if (!(uri instanceof vscode.Uri)) throw new Error('Select targets from an apm.yml file.');
    const document = await vscode.workspace.openTextDocument(uri);
    if (!safe(document)) throw new Error('Target selection requires a trusted workspace apm.yml file.');
    const { document: yaml, errors } = manifestContext(document.getText());
    if (errors.length || !isMap(yaml.contents)) throw new Error('Cannot select targets from an invalid apm.yml file.');
    const target = manifestTargets(yaml);
    if (!target?.key.range || !target.value.range) {
      throw new Error('The apm.yml targets array is no longer available.');
    }
    const current = target.value.items.flatMap(item => isScalar(item) && typeof item.value === 'string' ? [item.value] : []);
    const available = targetOptions();
    const choices = [...new Set([...available, ...current])].map(value => ({
      label: value,
      ...(current.includes(value) ? { picked: true } : {}),
      ...(available.includes(value) ? {} : { description: 'Existing value not listed by the available targets' })
    }));
    const selected = await vscode.window.showQuickPick(choices, {
      title: 'Select APM deployment targets',
      placeHolder: 'Choose the targets for this project',
      canPickMany: true
    });
    if (!selected) return;
    const keyPosition = document.positionAt(target.key.range[0]);
    const line = document.lineAt(keyPosition.line);
    const fieldIndent = line.text.slice(0, keyPosition.character);
    const firstItem = target.value.items[0];
    const itemIndent = isNode(firstItem) && firstItem.range
      ? document.lineAt(document.positionAt(firstItem.range[0]).line).text.match(/^\s*/)?.[0] ?? `${fieldIndent}  `
      : `${fieldIndent}  `;
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const replacement = selected.length
      ? `${fieldIndent}targets:${eol}${selected.map(item => `${itemIndent}- ${stringify(item.label).trim()}`).join(eol)}${eol}`
      : '';
    const text = document.getText();
    const startOffset = text.lastIndexOf('\n', target.key.range[0] - 1) + 1;
    const start = document.positionAt(startOffset);
    const end = document.positionAt(target.value.range[1]);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(start.line, start.character, end.line, end.character), replacement);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not update the apm.yml targets array.');
  }));
  registrations.push(vscode.languages.registerDocumentLinkProvider(selector, {
    provideDocumentLinks(document) {
      const yaml = validManifest(document);
      if (!yaml) return [];
      const links: vscode.DocumentLink[] = [];
      for (const block of ['dependencies', 'devDependencies']) {
        const sequence = yaml.getIn([block, 'apm'], true);
        if (!isSeq(sequence)) continue;
        for (const node of sequence.items) {
          if (!isScalar(node) || typeof node.value !== 'string' || !node.range || containsUrlCredentials(node.value)) continue;
          const value = node.value;
          const shorthand = value.match(/^([\w.-]+\/[\w.-]+)(?:#.*)?$/);
          const url = /^https:\/\/[^ ]+$/.test(value) ? value.split('#')[0] : shorthand ? `https://github.com/${shorthand[1]}` : undefined;
          if (!url) continue;
          const link = new vscode.DocumentLink(new vscode.Range(document.positionAt(node.range[0]), document.positionAt(node.range[1])), vscode.Uri.parse(url));
          link.tooltip = 'Open dependency source (does not install)'; links.push(link);
        }
      }
      return links;
    }
  }));
  const diagnostics = vscode.languages.createDiagnosticCollection('apm-manifest');
  const validateLocal = (document: vscode.TextDocument) => {
    if (!safeYaml(document)) { diagnostics.delete(document.uri); return; }
    const context = manifestContext(document.getText());
    const entries = vscode.extensions.getExtension('redhat.vscode-yaml')?.isActive ? [] : context.errors.map(error => {
      const diagnostic = new vscode.Diagnostic(new vscode.Range(document.positionAt(error.pos[0]), document.positionAt(error.pos[1])), error.message, vscode.DiagnosticSeverity.Error);
      diagnostic.source = 'APM YAML syntax'; return diagnostic;
    });
    if (!context.errors.length && typeof context.schema !== 'string') {
      for (const issue of yamlIssues(context.document, definition(document))) {
        const diagnostic = new vscode.Diagnostic(new vscode.Range(document.positionAt(issue.start), document.positionAt(issue.end)), issue.message, vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'APM local validation'; entries.push(diagnostic);
      }
    }
    const schema = context.document.get('$schema', true);
    if (isScalar(schema) && schema.range) {
      const diagnostic = new vscode.Diagnostic(new vscode.Range(document.positionAt(schema.range[0]), document.positionAt(schema.range[1])),
        'Explicit APM contract: verify this schema identity is supported by your installed CLI. Editor completion does not establish contract compatibility. Use APM: Validate Manifest and Primitives.', vscode.DiagnosticSeverity.Information);
      diagnostic.source = 'APM contract'; entries.push(diagnostic);
    }
    diagnostics.set(document.uri, entries);
  };
  registrations.push(diagnostics, vscode.workspace.onDidOpenTextDocument(validateLocal),
    vscode.workspace.onDidChangeTextDocument(event => validateLocal(event.document)),
    vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri)));
  for (const document of vscode.workspace.textDocuments) validateLocal(document);
  registrations.push(vscode.languages.registerCodeActionsProvider(selector, {
    provideCodeActions(document, range) {
      if (!safe(document)) return [];
      const action = new vscode.CodeAction('APM: Validate manifest and primitives with CLI', vscode.CodeActionKind.Source);
      action.command = { command: 'apm.validate', title: action.title, arguments: [document.uri] };
      const actions = [action];
      const value = document.getText(range).trim();
      if (value && !containsUrlCredentials(value) && /^[\w.-]+\/[\w./-]+(?:#[\w./-]+)?$/.test(value)) {
        const details = new vscode.CodeAction('APM: Open selected dependency details', vscode.CodeActionKind.Refactor);
        details.command = { command: 'apm.dependencyDetails', title: details.title, arguments: [value, document.uri] }; actions.push(details);
      }
      return actions;
    }
  }));
  registrations.push(vscode.commands.registerCommand('apm.dependencyDetails', (dependency: unknown, uri: unknown) => {
    if (!vscode.workspace.isTrusted || typeof dependency !== 'string' || containsUrlCredentials(dependency) || !(uri instanceof vscode.Uri)) throw new Error('Select a credential-free dependency in a trusted workspace.');
    return callbacks.details(dependency, uri);
  }));
  return vscode.Disposable.from(...registrations);
}
