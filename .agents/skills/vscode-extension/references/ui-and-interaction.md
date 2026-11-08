# UI and Interaction

## Prefer the native surface

Use the narrowest familiar VS Code surface that fits the task. Avoid duplicating built-in behavior or introducing custom UI where a contribution point or API already works.

| Need | Prefer |
| --- | --- |
| Discoverable action | Command Palette command with a clear title and category. |
| Contextual action | Menu contribution with a precise `when` clause and sensible group/order. |
| Structured navigation or hierarchy | Tree View, with useful empty-state guidance when needed. |
| Short choice or a few related inputs | Quick Pick, Input Box, or a short multi-step Quick Pick flow. |
| Diagnostics or file findings | Diagnostic collection and Problems; use Code Actions for local fixes. |
| Long-running operation | View/editor progress first; cancellable progress notification only when global attention is justified. |
| Persistent contextual signal | Status bar item only while the state is relevant. |
| Custom, interactive workspace UI | Webview only when native APIs are insufficient. |

Use Activity Bar containers and Views sparingly. Provide icons because Views can move between containers. Prefer tree items for navigation/content, not as button substitutes. Keep actions and view names concise.

## Commands and contributions

- Declare public commands in `contributes.commands` with user-oriented titles and, when useful, a category and icon.
- Register each command in code and add its disposables to `context.subscriptions`. Keep IDs stable; use `when` clauses to expose commands only in relevant contexts.
- Add menus, keybindings, views, settings, and activation events only when they serve a real entry point. Keep menu conditions aligned with runtime checks.
- Group related actions; hide internal or redundant commands from the Command Palette where appropriate.
- Use a Quick Pick for choices and an Input Box for concise free-form input. Give each field a useful title or placeholder, validate input, and treat dismissal as cancellation.
- Use multi-step Quick Picks for short related flows, not as long wizards. Do not start a mutation before the user has supplied and confirmed required inputs.

### Example: contribute and register a command

The manifest declaration makes the command discoverable; the runtime registration supplies its behavior. Replace IDs, labels, contexts, and validation with the extension's actual feature.

```json
{
  "contributes": {
    "commands": [
      {
        "command": "sample.openReport",
        "title": "Open Report",
        "category": "Sample"
      }
    ],
    "menus": {
      "editor/context": [
        {
          "command": "sample.openReport",
          "when": "editorHasSelection",
          "group": "navigation"
        }
      ]
    }
  }
}
```

```ts
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Sample');
  const command = vscode.commands.registerCommand('sample.openReport', async () => {
    try {
      const document = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: '# Report\n\nReplace this content with the feature result.'
      });
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error: unknown) {
      output.appendLine(`Opening report failed (${error instanceof Error ? error.name : 'unknown error'}).`);
      const choice = await vscode.window.showErrorMessage(
        'Could not open the report.', 'Show Output'
      );
      if (choice === 'Show Output') output.show();
    }
  });

  context.subscriptions.push(output, command);
}
```

Treat failures as failures: do not display success after an exception. This example logs the error category rather than potentially sensitive messages. Use an extension-owned redactor to include useful message/stack details safely when needed.

## Notifications and progress

- Notify only when the user needs to act or know an outcome. Avoid repeated, promotional, or success-shaped messages that hide failures.
- Use information, warning, or error messages according to severity. Add actions only when they lead to a relevant next step; expose detailed logs in an Output channel.
- Prefer inline/view/editor progress. Use global notification progress sparingly, report useful stages, and provide cancellation when supported.
- Keep confirmations tied to explicit user actions. Do not use modal dialogs for status messages or background events.
- Combine related notices and let the user reopen details rather than flooding them.

### Example: choose, confirm, then act

This helper captures the selected URI before awaiting approval. Supply an operation that writes or replaces a report and catches/reports failures at the calling command boundary.

```ts
import * as vscode from 'vscode';

async function chooseReportTarget(
  createReport: (target: vscode.Uri) => Promise<void>
): Promise<void> {
  const choices: (vscode.QuickPickItem & { uri: vscode.Uri })[] = [];
  const document = vscode.window.activeTextEditor?.document;
  if (document) choices.push({
    label: 'Current file', description: document.uri.toString(), uri: document.uri
  });
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    choices.push({ label: folder.name, description: 'Workspace folder', uri: folder.uri });
  }
  if (!choices.length) {
    await vscode.window.showInformationMessage('Open a file or workspace folder first.');
    return;
  }
  const choice = await vscode.window.showQuickPick(choices, {
    title: 'Create report', placeHolder: 'Choose the report scope'
  });
  if (!choice) return;

  const confirmation = await vscode.window.showWarningMessage(
    `Create or replace the report for ${choice.label}?`, 'Create'
  );
  if (confirmation !== 'Create') return;
  await createReport(choice.uri);
}
```

`showWarningMessage` is non-modal unless `modal: true` is specified. Confirmation is appropriate only for a meaningful mutation or consequential action; do not add it to routine, reversible actions.

## Settings and visual customization

- Contribute settings with descriptions, valid types/defaults, and the narrowest correct scope. Mark security-sensitive settings as restricted when supported.
- Use built-in product icons, theme colors, and established layouts before adding custom visual language.
- For custom surfaces, support keyboard navigation, visible focus, screen readers, contrast, light/dark/high-contrast themes, and narrow layouts.
- Keep state persistent only when users expect it; restore views without unexpectedly repeating expensive operations.
- Use `workspaceState` for workspace-local preferences and `globalState` for cross-workspace preferences. Store credentials in `context.secrets`, not either state store.
- Read resource-scoped settings with the relevant URI, and react to `onDidChangeConfiguration` only when the affected setting matters.

## Sources

- [UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/overview)
- [Views](https://code.visualstudio.com/api/ux-guidelines/views)
- [Quick Picks](https://code.visualstudio.com/api/ux-guidelines/quick-picks)
- [Notifications](https://code.visualstudio.com/api/ux-guidelines/notifications)
- [Commands](https://code.visualstudio.com/api/extension-guides/command)
- [Contribution Points](https://code.visualstudio.com/api/references/contribution-points)
