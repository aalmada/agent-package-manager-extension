# Analyze an Extension Project

## Inspect before changing

| Inspect | Learn |
| --- | --- |
| `package.json` | Supported VS Code engine, extension kind, activation events, capabilities, contributions, scripts, dependencies, and package metadata. |
| Extension entry point and registration modules | Activation cost, command handlers, provider ownership, disposables, error paths, and host boundaries. |
| Feature modules | Existing adapters, state flow, validation, configuration, file navigation, and external process/network behavior. |
| Tests and local instructions | Test runners, fixtures, known constraints, and behavior that must remain stable. |
| CI and release workflows | Supported OS/runtime matrix, required test suites, package artifact, permissions, and release gates. |
| README, changelog, and contribution docs | User-facing behavior, setup, command names, compatibility, and release conventions. |

Use the repository's code index or language tooling to find implementations and callers. Confirm relevant files directly, especially configuration, generated files, and code outside the index. Check for ignored or generated paths before editing.

## Trace a feature

1. Find the manifest contribution and its runtime registration. Confirm visibility conditions, command IDs, titles, and activation behavior agree.
2. Follow the action from UI entry point through validation and state changes to its provider, process, or network adapter.
3. Identify the response path: inline result, Output channel, Problems, editor, task, notification, or webview state.
4. Find tests for success, failure, cancellation, disposal, and untrusted or missing-workspace behavior.
5. Record affected docs, manifest fields, tests, CI, and release metadata before editing.

Do not treat manifest declarations as proof a feature works, or runtime registrations as proof a command is discoverable. Verify both sides and their user-facing route.

## Choose the feature API

| Feature | Extension surface |
| --- | --- |
| Completion, hover, navigation, formatting, or fixes | `languages.register*Provider` APIs; use document selectors and cancellation tokens. Consider a language server for reusable language intelligence. |
| Reusable workspace jobs | `TaskProvider` and `contributes.taskDefinitions`; discover without executing, execute only on invocation. |
| Debugging | Debug configuration and adapter descriptor providers with `contributes.debuggers`. |
| Specialized file editing | `CustomTextEditorProvider` or `CustomEditorProvider` with `contributes.customEditors`; preserve save, undo/redo, and backup contracts. |
| Account integration | `authentication.getSession`; use an `AuthenticationProvider` only when supplying an authentication service. |
| Test discovery and execution for users | `tests.createTestController`; this is separate from tests of the extension itself. |
| Read-only computed documents | `TextDocumentContentProvider`; use a dedicated URI scheme. |
| Declarative customization | Theme, grammar, snippet, menu, or keybinding contribution points; runtime activation may be unnecessary. |

## Activation and compatibility

- Activate on the narrowest event that serves the feature. Avoid `*` and `onStartupFinished` unless startup work is essential; defer expensive initialization until the feature is used.
- VS Code 1.74 and later automatically activate contributed commands and languages without matching `onCommand` or `onLanguage` entries. If supporting older versions, declare those events explicitly. Check each other contribution's activation rules separately.
- Keep `engines.vscode` aligned with the oldest API used and test that minimum as well as current stable. Newer type definitions do not make newer APIs available on older hosts.
- Separate Node-host (`main`) and web-host (`browser`) bundles when supporting both. `extensionKind` controls preferred host placement, not web compatibility.
- Web extensions cannot use Node.js APIs or launch executables. Use URI-based `workspace.fs` rather than assuming local paths, and test remote and virtual filesystems where supported.
- For debugging, use an Extension Development Host launch configuration. Use **Developer: Show Running Extensions** and extension-host logs to investigate activation time and runtime failures.

## Extension-host boundaries

Establish whether the extension runs in the UI or workspace host, and whether it supports remote or virtual workspaces. Check workspace trust declarations and actual guards around file access, process execution, and network operations. Test multi-root behavior wherever workspace scope matters.

Distinguish these surfaces when planning validation:

| Surface | Typical validation |
| --- | --- |
| Pure logic or adapters | Unit tests with deterministic fixtures. |
| VS Code API integration | Extension Host tests with mocked external services or disposable workspaces. |
| Webview rendering and interaction | Browser tests for layouts, themes, accessibility, and message handling. |
| Packaging and runtime compatibility | Type-check, production build, VSIX package inspection, and supported-platform CI. |

## Sources

- [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)
- [Contribution Points](https://code.visualstudio.com/api/references/contribution-points)
- [Extension API overview](https://code.visualstudio.com/api)
- [Activation Events](https://code.visualstudio.com/api/references/activation-events)
- [Web Extensions](https://code.visualstudio.com/api/extension-guides/web-extensions)
