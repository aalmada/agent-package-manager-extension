# Script instructions

Follow the [root guidance](../AGENTS.md) for shared commands and safety rules.

- [`build.mjs`](build.mjs) bundles the extension, browser webview, and extension-host tests, copies CSS, and collects production dependency licenses. Preserve its failure when a required license is missing.
- [`sync-contract.py`](sync-contract.py) downloads the pinned upstream release and statically parses Python Click declarations and declarative choice helpers. Do not import or execute downloaded Python. Fail on unresolved choice expressions rather than silently dropping allowed values; validate generated contract changes with the opt-in live CLI tests.
- [`test-extension.mjs`](test-extension.mjs) creates an isolated home, user-data directory, and extension directory before launching VS Code. Preserve that isolation when changing the runner.
- The build's watch mode watches TypeScript but does not recopy CSS after startup; rerun the build for CSS changes.
