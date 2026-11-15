# Contributing

Thanks for helping improve APM for VS Code. Keep changes focused, include tests for behavior changes, and update user documentation when a change affects how the extension is used.

## Before you start

- Follow the [code of conduct](CODE_OF_CONDUCT.md).
- Search [existing issues](https://github.com/aalmada/agent-package-manager-extension/issues) before submitting a [bug report or feature request](https://github.com/aalmada/agent-package-manager-extension/issues/new/choose).
- Report vulnerabilities privately using the [security policy](SECURITY.md), not a public issue.
- For a substantial feature or design change, open an issue to agree on scope before implementing it. Small fixes and documentation improvements can go straight to a pull request.
- Look for [`good first issue`](https://github.com/aalmada/agent-package-manager-extension/labels/good%20first%20issue) or [`help wanted`](https://github.com/aalmada/agent-package-manager-extension/labels/help%20wanted) labels. Comment before starting an existing issue to avoid duplicating work.

APM owns package resolution and mutations; this repository supplies the VS Code interface and adapters. If a problem reproduces directly in the CLI, check [Microsoft APM's issues](https://github.com/microsoft/apm/issues).

## Development setup

Fork the repository, clone your fork, and create a focused branch from `main`. Use Node.js 22, matching CI. Install dependencies from the lockfile and run the core checks:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Press **F5** in VS Code to launch the Extension Development Host. Run `npm run watch` to rebuild TypeScript as you edit; rerun the build after changing webview CSS.

To investigate Node deprecation warnings, select **Run APM Extension (Trace Deprecations)** in Run and Debug, then press **F5**. This optional [launch configuration](.vscode/launch.json) preserves existing `NODE_OPTIONS` and adds `--trace-deprecation`. Inspect the warning's stack in the Debug Console to identify the calling file or extension; other enabled extensions share the host, so a warning forwarded by `extensionHostProcess.js` does not identify APM as its source. Do not suppress warnings or share raw logs containing private data.

The workspace disables VS Code's experimental Debug Network view to avoid a [Node inspector crash](https://github.com/nodejs/node/issues/64308) when the extension host starts or reloads. Other debugging features remain available. In a multi-root workspace, set `debug.javascript.enableNetworkView` to `false` in the workspace-level settings instead; restart the debug session after changing it.

## Tests

- `npm test` runs the unit tests. Tests that require a real APM CLI are skipped unless configured.
- `npm run test:browser` runs the Playwright browser tests. Install Chromium first with `npx playwright install chromium`.
- `npm run test:extension` runs the VS Code extension-host tests. It downloads a VS Code test build if `VSCODE_EXECUTABLE_PATH` is not set.
- `npm run package` creates a VSIX package.

The extension-host runner creates the project manifest before VS Code starts and overrides the default marketplaces with local fixtures. Keep these tests independent of remote repository access and credentials.

To run the real-CLI tests, provide an isolated APM 0.35.0 executable. The tests use disposable homes and workspaces; they do not install or upgrade your CLI.

```bash
APM_TEST_EXECUTABLE=/path/to/apm-0.35.0 npm test
```

An optional legacy CLI executable can be provided with `APM_LEGACY_EXECUTABLE` for compatibility tests.

To opt into the isolated private direct-install test, set `APM_TEST_EXECUTABLE` to APM 0.35.0, `APM_PRIVATE_TEST_SOURCE` to a private GitHub.com package source, and `APM_PRIVATE_TEST_TOKEN` to a token with access to it. The test writes to a temporary home and project and performs a real installation. Never commit the token.

```bash
npx tsx --test test/apm/privateLive.test.ts
```

Commit `apm.yml`, `apm.lock.yaml`, and APM-deployed agent files, including `.agents/skills/`, so dependency changes are reviewable and skills are available immediately after cloning. Keep the `apm_modules/` dependency cache gitignored. Update deployed files through APM, not by hand; review and commit them alongside manifest and lockfile changes. See [APM's commit guidance](https://github.com/microsoft/apm/blob/main/docs/src/content/docs/consumer/install-packages.md#what-to-commit).

## Publishing

The manually triggered [publishing workflow](.github/workflows/publish.yml) reruns the cross-platform CI checks and publishes the validated Linux VSIX. It uses [Marketplace Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing), not a stored personal access token.

Before the first release, create a Trusted Publishing policy for the `antao-almada` Marketplace publisher with these values:

- Repository owner: `aalmada`
- Repository: `agent-package-manager-extension`
- Workflow: `publish.yml`
- Environment: leave empty

To release, update the version in `package.json` and `package-lock.json` with `npm version <version> --no-git-tag-version`, update [CHANGELOG.md](CHANGELOG.md), and merge the changes into the default branch. Then run **Publish to VS Code Marketplace** from the repository's Actions tab. The workflow accepts only the default branch and reports a failure if validation or publishing fails.

## Documentation

The [user guide](docs/user-guide.md) is the root of the user documentation; each topic has its own page in [`docs/`](docs/). When a change adds or moves an operation, update every entry point it lists: the APM view, Command Palette, context menus, More APM Actions, settings, and tasks. Update [Commands](docs/commands.md) and [Settings](docs/settings.md) when changing `package.json` contributions.

Screenshots in [`docs/images/`](docs/images/) are rendered from the built webview with fictional fixture data, so they never contain private packages or credentials. After changing the webview, regenerate them:

```bash
npm run build
npm run docs:screenshots
```

Pass `-- --output <directory>` to write the images elsewhere for comparison. Install Chromium first with `npx playwright install chromium`. The `docs/` folder is excluded from the VSIX; the Marketplace resolves the README's relative image links against the GitHub repository.

## Updating the visual command contract

The generated command contract in `src/apm/contract.json` is pinned to APM 0.35.0. To regenerate it, run:

```bash
python3 scripts/sync-contract.py
```

The script downloads the pinned APM source and statically reads its Click declarations; it does not execute the downloaded Python. When changing the supported baseline, regenerate the contract and run the real-CLI tests against that release.

## Pull requests

Before submitting a pull request, run the checks relevant to your change. For changes to command forms or CLI compatibility, include contract and real-CLI test results where possible. Do not include credentials or private marketplace data in tests, screenshots, or logs.

Open the pull request against `main` and fill in the template with the motivation, related issues, and validation results. Use a draft pull request when you want early feedback. Documentation-only changes do not require local code checks.

CI runs on Linux, Windows, and macOS. Merging requires those checks to pass, the branch to be up to date, one approving review, and review conversations to be resolved. New commits dismiss stale approvals. Administrators retain a bypass for exceptional maintenance; contributors cannot bypass these requirements. A maintainer is automatically requested for review through [CODEOWNERS](.github/CODEOWNERS).

Contributions are accepted under the repository's [MIT license](LICENSE). No contributor license agreement or Developer Certificate of Origin sign-off is currently required.

## GitHub maintenance

Issue forms, the pull request template, CODEOWNERS, and Dependabot configuration live in [`.github/`](.github/). These become active after they are merged into the default branch. Keep GitHub Actions pinned to full commit SHAs when reviewing dependency updates. Dependabot proposes weekly npm and Actions updates; it does not manage APM dependencies.

The following settings are managed on GitHub, not by these files. Recheck them when transferring or recreating the repository:

- Protect `main` with required checks `test (ubuntu-latest)`, `test (windows-latest)`, and `test (macos-latest)`, using the GitHub Actions app. Require up-to-date branches, one approval, stale-review dismissal, and resolved conversations. Block force pushes and branch deletion.
- Enable private vulnerability reporting and retain secret scanning, push protection, and Dependabot security updates.
- Keep the default Actions token read-only and prevent Actions from creating or approving pull requests. Review workflows from forks before allowing them to run; never execute untrusted pull request code through `pull_request_target` with privileged credentials.
- Automatically delete merged branches. Apply `bug`, `enhancement`, `documentation`, `good first issue`, and `help wanted` labels as appropriate; issue-form labels must already exist.

Discussions, funding links, automatic merging, and additional bots are optional. Add them only when there is a clear use and capacity to maintain them; inactive-issue automation can discourage contributors.
