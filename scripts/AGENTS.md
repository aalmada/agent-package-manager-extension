# Script instructions

Follow the [root guidance](../AGENTS.md) for shared commands and safety rules.

- [`build.mjs`](build.mjs) bundles the extension, browser webview, and extension-host tests, copies CSS, and collects production dependency licenses. Preserve its failure when a required license is missing.
- [`sync-contract.py`](sync-contract.py) downloads the pinned upstream release and statically parses Python Click declarations and declarative choice helpers. Do not import or execute downloaded Python. Fail on unresolved choice expressions rather than silently dropping allowed values; validate generated contract changes with the opt-in live CLI tests.
- [`test-extension.mjs`](test-extension.mjs) creates an isolated home, user-data directory, and extension directory before launching VS Code. Preserve that isolation when changing the runner.
- [`docs-screenshots.ts`](docs-screenshots.ts) renders the built webview in headless Chromium with fictional fixture state and writes `docs/images/`. Keep fixtures free of real packages, private sources, and credentials. Pass page-side code to `page.evaluate` as strings, because `tsx` injects helpers that do not exist in the page.
- The build's watch mode watches TypeScript but does not recopy CSS after startup; rerun the build for CSS changes.
