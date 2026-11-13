---
name: vscode-extension
description: "Build, maintain, debug, and review Visual Studio Code extensions. Use when: extension manifest, activation, commands, views, tree views, webviews, notifications, settings, language providers, tasks, debuggers, custom editors, authentication, Accounts, sign-in, account management, session lifecycle, Workspace Trust, desktop or web compatibility, testing, CI, packaging, Marketplace publishing. DO NOT USE FOR: general web applications or Copilot agent customization; use the relevant web-development or agent-authoring guidance."
---

# VS Code Extension

## Extension workflow

1. Inspect the manifest, activation and registration code, project instructions, tests, CI, and release workflow before changing behavior. Start with [project analysis](references/project-analysis.md).
2. Reuse the extension's existing architecture and UX. Prefer VS Code native APIs; use a webview only when native APIs cannot support the interaction.
3. Keep the extension host, webview, and external process boundaries explicit. Preserve Workspace Trust, cancellation, disposal, and error reporting.
4. Test the changed surface at the right level, then validate the package and release path when relevant.

## Core checks

| Area | Check |
| --- | --- |
| Manifest | Keep contributed commands, menus, views, settings, activation, and engine compatibility in sync with runtime registrations. |
| UX | Use focused commands and native pickers, notifications, views, and progress. Keep custom UI accessible, theme-aware, and contextual. |
| CodeLens | Use a CodeLens for a concise action tied to a nearby declaration. Keep discovery read-only; run edits through a registered command, validate current document state, and apply a minimal `WorkspaceEdit` that preserves surrounding text and comments. Test placement, selection, cancellation, and preservation. |
| Host behavior | Handle no workspace, multi-root, trusted/untrusted, local/remote, and cancellation states where applicable. |
| Safety | Validate input at boundaries; do not run workspace code or network work during discovery, completion, or activation without a clear need. |
| Quality | Separate unit, Extension Host, and browser tests; run the smallest relevant checks and build/package validation. |

## References

| File | Load when |
| --- | --- |
| [project-analysis.md](references/project-analysis.md) | Exploring an existing extension and planning a change. |
| [ui-and-interaction.md](references/ui-and-interaction.md) | Choosing native UI, commands, notifications, settings, or customizations. |
| [progress-and-cancellation.md](references/progress-and-cancellation.md) | Reporting long-running work, handling cancellation, and cleaning up operations. |
| [webviews-and-security.md](references/webviews-and-security.md) | Implementing a webview or handling trust, remote workspaces, credentials, or process execution. |
| [authentication-and-accounts.md](references/authentication-and-accounts.md) | Integrating Accounts, sign-in, account selection, session changes, credential transport, or an authentication provider. |
| [testing-ci-publishing.md](references/testing-ci-publishing.md) | Adding tests, configuring CI, packaging, or publishing. |
