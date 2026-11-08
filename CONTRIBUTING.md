# Contributing

Thanks for helping improve APM for VS Code. Keep changes focused, include tests for behavior changes, and update user documentation when a change affects how the extension is used.

## Development setup

Install dependencies and run the core checks:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Press **F5** in VS Code to launch the Extension Development Host. Run `npm run watch` to rebuild TypeScript as you edit; rerun the build after changing webview CSS.

The workspace disables VS Code's experimental Debug Network view to avoid a [Node inspector crash](https://github.com/nodejs/node/issues/64308) when the extension host starts or reloads. Other debugging features remain available. In a multi-root workspace, set `debug.javascript.enableNetworkView` to `false` in the workspace-level settings instead; restart the debug session after changing it.

## Tests

- `npm test` runs the unit tests. Tests that require a real APM CLI are skipped unless configured.
- `npm run test:browser` runs the Playwright browser tests. Install Chromium first with `npx playwright install chromium`.
- `npm run test:extension` runs the VS Code extension-host tests. It downloads a VS Code test build if `VSCODE_EXECUTABLE_PATH` is not set.
- `npm run package` creates a VSIX package.

To run the real-CLI tests, provide an isolated APM 0.35.0 executable. The tests use disposable homes and workspaces; they do not install or upgrade your CLI.

```bash
APM_TEST_EXECUTABLE=/path/to/apm-0.35.0 npm test
```

An optional legacy CLI executable can be provided with `APM_LEGACY_EXECUTABLE` for compatibility tests.

Commit `apm.yml`, `apm.lock.yaml`, and APM-deployed agent files, including `.agents/skills/`, so dependency changes are reviewable and skills are available immediately after cloning. Keep the `apm_modules/` dependency cache gitignored. Update deployed files through APM, not by hand; review and commit them alongside manifest and lockfile changes. See [APM's commit guidance](https://github.com/microsoft/apm/blob/main/docs/src/content/docs/consumer/install-packages.md#what-to-commit).

## Publishing

The manually triggered [publishing workflow](.github/workflows/publish.yml) reruns the cross-platform CI checks and publishes the validated Linux VSIX. It uses [Marketplace Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing), not a stored personal access token.

Before the first release, create a Trusted Publishing policy for the `antao-almada` Marketplace publisher with these values:

- Repository owner: `aalmada`
- Repository: `agent-package-manager-extension`
- Workflow: `publish.yml`
- Environment: leave empty

To release, update the version in `package.json` and `package-lock.json` with `npm version <version> --no-git-tag-version`, update [CHANGELOG.md](CHANGELOG.md), and merge the changes into the default branch. Then run **Publish to VS Code Marketplace** from the repository's Actions tab. The workflow accepts only the default branch and reports a failure if validation or publishing fails.

## Updating the visual command contract

The generated command contract in `src/apm/contract.json` is pinned to APM 0.35.0. To regenerate it, run:

```bash
python3 scripts/sync-contract.py
```

The script downloads the pinned APM source and statically reads its Click declarations; it does not execute the downloaded Python. When changing the supported baseline, regenerate the contract and run the real-CLI tests against that release.

## Pull requests

Before submitting a pull request, run the checks relevant to your change. For changes to command forms or CLI compatibility, include contract and real-CLI test results where possible. Do not include credentials or private marketplace data in tests, screenshots, or logs.
