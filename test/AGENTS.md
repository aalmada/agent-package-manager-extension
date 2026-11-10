# Test instructions

Follow the [root guidance](../AGENTS.md) for shared commands and safety rules.

- Unit tests use `node:test` and `node:assert/strict`. The `npm test` script runs `*.test.ts` files, not Playwright or the extension-host suite.
- [`apm/live.test.ts`](apm/live.test.ts) is enabled by `APM_TEST_EXECUTABLE` and expects APM 0.35.0. [`apm/legacy.test.ts`](apm/legacy.test.ts) is enabled by `APM_LEGACY_EXECUTABLE` and expects APM 0.28.0. Both use disposable homes; neither installs or upgrades the CLI.
- [`apm/taskRouting.test.ts`](apm/taskRouting.test.ts) exercises command dispatch against a mocked VS Code task API, including interactive initialization, watch cancellation, startup failure, and disposal; it does not launch a GUI or run APM.
- [`apm/nativeUx.test.ts`](apm/nativeUx.test.ts) tests offline task discovery, contract-aware manifest context, target parsing, contained file navigation, and physical/decoded audit Problems using a mocked host and disposable files.
- [`browser/webview.spec.ts`](browser/webview.spec.ts) uses the built webview JavaScript and CSS, tests narrow layouts in three themes, and writes screenshots to the Playwright output directory.
- [`extension/suite.ts`](extension/suite.ts) runs through the isolated VS Code host runner and exercises native settings synchronization and editor views. It requires a built test bundle and an APM executable.
- Keep tests isolated from the developer's APM home and registry. Use temporary fixtures and surface failures rather than treating missing or malformed data as success.
- Test account routing with synthetic credentials and mocked provider responses. Cover same-host repositories using different accounts, redirect/host isolation, token removal, silent background lookup, and rejection before process startup when APM cannot route mixed credentials.
