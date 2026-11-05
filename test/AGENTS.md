# Test instructions

Follow the [root guidance](../AGENTS.md) for shared commands and safety rules.

- Unit tests use `node:test` and `node:assert/strict`. The `npm test` script runs `*.test.ts` files, not Playwright or the extension-host suite.
- [`apm/live.test.ts`](apm/live.test.ts) is enabled by `APM_TEST_EXECUTABLE` and expects APM 0.35.0. [`apm/legacy.test.ts`](apm/legacy.test.ts) is enabled by `APM_LEGACY_EXECUTABLE` and expects APM 0.28.0. Both use disposable homes; neither installs or upgrades the CLI.
- [`browser/webview.spec.ts`](browser/webview.spec.ts) uses the built webview JavaScript and CSS, tests narrow layouts in three themes, and writes screenshots to the Playwright output directory.
- [`extension/suite.ts`](extension/suite.ts) runs through the isolated VS Code host runner and exercises native settings synchronization and editor views. It requires a built test bundle and an APM executable.
- Keep tests isolated from the developer's APM home and registry. Use temporary fixtures and surface failures rather than treating missing or malformed data as success.
