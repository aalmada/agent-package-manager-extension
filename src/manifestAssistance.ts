import * as vscode from 'vscode';
import { basename } from 'node:path';
import { isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml';
import { descriptors } from './apm/commands';
import { containsUrlCredentials } from './apm/redact';
import { parseTargets } from './apm/actions';
import packageManifest from '../package.json';

export const manifestFields: Record<string, string> = {
  name: 'Package identifier.', version: 'Package version.', description: 'Short package description.', author: 'Package author.',
  license: 'Package license.', targets: 'Explicit harness targets. Omit to use APM target resolution.',
  dependencies: 'Agent packages, MCP servers, and LSP servers installed by APM.', devDependencies: 'Development-only dependencies.',
  scripts: 'Named commands. Execution is explicit and requires APM experimental script support.',
  includes: 'Local content to publish. auto selects the authoritative source layout.',
  compilation: 'Context compilation options.', policy: 'Consumer-side policy controls.', marketplace: 'Marketplace authoring metadata.',
  registries: 'Registry configuration; semantics depend on the selected manifest contract.',
  '$schema': 'Explicit manifest contract identity. Omission selects the CLI working draft; do not select a schema just for editor completion.'
};
export function manifestContext(text: string) {
  const document = parseDocument(text);
  return { document, schema: document.get('$schema'), errors: document.errors };
}
function targetOptions(): string[] {
  const option = descriptors.find(command => command.id === 'install')?.options.find(option => option.name === '--target');
  const documented = parseTargets(`--target ${option?.description ?? ''}`);
  return option?.choices ?? (documented.length ? documented : packageManifest.contributes.configuration.flatMap(group => group.properties['apm.config.target']?.items.enum ?? []));
}
export function registerManifestAssistance(callbacks: { details(dependency: string, uri: vscode.Uri): Promise<void> }): vscode.Disposable {
  const selector: vscode.DocumentSelector = { scheme: 'file', language: 'yaml', pattern: '**/apm.yml' };
  const registrations: vscode.Disposable[] = [];
  const safe = (document: vscode.TextDocument) => vscode.workspace.isTrusted && basename(document.uri.fsPath) === 'apm.yml' && document.getText().length <= 1024 * 1024;
  registrations.push(vscode.languages.registerCompletionItemProvider(selector, {
    provideCompletionItems(document, position) {
      if (!safe(document)) return [];
      const context = manifestContext(document.getText());
      const before = document.lineAt(position.line).text.slice(0, position.character);
      const parent = document.getText().split(/\r?\n/).slice(0, position.line).reverse().find(line => /^[^\s#][\w$-]*:/.test(line));
      if (/^\s*-\s*[\w-]*$/.test(before) && /^targets?:\s*$/.test(parent ?? '')) {
        return targetOptions().map(target => new vscode.CompletionItem(target, vscode.CompletionItemKind.EnumMember));
      }
      if (!/^[\w$-]*$/.test(before)) return [];
      const existing = isMap(context.document.contents) ? context.document.contents.items.map(pair => String(pair.key)) : [];
      const hasYaml = vscode.extensions.getExtension('redhat.vscode-yaml')?.isActive;
      if (hasYaml && typeof context.schema === 'string') return [];
      return Object.entries(manifestFields).filter(([field]) => !existing.includes(field)).map(([field, description]) => {
        const item = new vscode.CompletionItem(field, vscode.CompletionItemKind.Property);
        item.detail = 'APM manifest'; item.documentation = description;
        item.insertText = new vscode.SnippetString(`${field}: \${1}`);
        return item;
      });
    }
  }, ':', '-'));
  registrations.push(vscode.languages.registerHoverProvider(selector, {
    provideHover(document, position) {
      if (!safe(document)) return;
      const word = document.getWordRangeAtPosition(position, /[$\w-]+/);
      const field = word && document.getText(word);
      if (!field || !manifestFields[field]) return;
      const context = manifestContext(document.getText());
      const schema = typeof context.schema === 'string' ? 'Explicit contract: inspect the selected schema and CLI support.' : 'No explicit schema: APM working draft. This extension does not claim complete schema validation.';
      return new vscode.Hover(`${manifestFields[field]}\n\n${schema}`, word);
    }
  }));
  registrations.push(vscode.languages.registerCodeLensProvider(selector, {
    provideCodeLenses(document) {
      if (!safe(document)) return [];
      const { document: yaml, errors } = manifestContext(document.getText());
      if (errors.length || !isMap(yaml.contents)) return [];
      const target = yaml.contents.items.find(pair => isScalar(pair.key) && pair.key.value === 'targets');
      if (!target || !isScalar(target.key) || !target.key.range || !isSeq(target.value)) return [];
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
    const target = yaml.contents.items.find(pair => isScalar(pair.key) && pair.key.value === 'targets');
    if (!target || !isScalar(target.key) || !target.key.range || !isSeq(target.value) || !target.value.range) {
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
    const itemIndent = firstItem?.range
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
      if (!safe(document)) return [];
      const { document: yaml, errors } = manifestContext(document.getText());
      if (errors.length) return [];
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
    if (!safe(document)) { diagnostics.delete(document.uri); return; }
    const context = manifestContext(document.getText());
    const entries = vscode.extensions.getExtension('redhat.vscode-yaml')?.isActive ? [] : context.errors.map(error => {
      const diagnostic = new vscode.Diagnostic(new vscode.Range(document.positionAt(error.pos[0]), document.positionAt(error.pos[1])), error.message, vscode.DiagnosticSeverity.Error);
      diagnostic.source = 'APM manifest syntax'; return diagnostic;
    });
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
