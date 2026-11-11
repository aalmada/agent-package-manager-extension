# Agent instructions

## Project

This repository is a TypeScript VS Code extension for Microsoft's Agent Package Manager (APM). APM owns package resolution and mutations; the extension supplies the interface and adapters.

- [`src/extension.ts`](src/extension.ts) hosts VS Code integration; [`src/protocol.ts`](src/protocol.ts) defines webview messages and state.
- [`src/apm/`](src/apm/) wraps the CLI and reads package metadata; [`src/config/`](src/config/) synchronizes settings with APM.
- [`src/webview/`](src/webview/) contains the browser UI; [`src/views/`](src/views/) provides the webview shell and sanitized Markdown.
- Keep search and filters fixed above the browser's custom sections. Preserve right-aligned filtered counts, accessible resize handles between package sections, and saved sizes and collapse state.
- [`src/navigation.ts`](src/navigation.ts) owns verified file links and audit Problems; [`src/manifestAssistance.ts`](src/manifestAssistance.ts) provides local YAML assistance; [`src/taskProvider.ts`](src/taskProvider.ts) discovers reusable tasks.
- [`scripts/`](scripts/) builds and generates the CLI contract; [`test/`](test/) contains unit, browser, and extension-host tests.

## Development

CI uses Node.js 22 and tests the baseline APM CLI on Linux, Windows, and macOS. Install npm dependencies from the lockfile; the [CI workflow](.github/workflows/ci.yml) contains setup and packaging steps. Run commands from the repository root.

- Use `codebase-memory-mcp` to search code structure, symbols, and relationships. Check index readiness and freshness before querying; index or update this repository when missing or stale, and refresh the index after code changes. Verify graph results against source when coverage is incomplete.
- `npm run typecheck`: check strict TypeScript types.
- `npm run lint`: lint TypeScript and JavaScript under source, tests, and scripts.
- `npm test`: run Node unit tests; real-CLI tests are opt-in.
- `npx tsx --test test/apm/commands.test.ts`: run one unit-test file.
- `npm run build`: bundle the extension, webview, and extension-host test; copy CSS and collect production licenses.
- `npm run test:browser`: after building, run Playwright tests with Chromium. Results go to `test-results/`; pass `-- --output <directory>` to preserve existing results.
- `npm run test:extension`: after building, run the VS Code host tests with an APM executable available. The runner resolves or downloads VS Code unless `VSCODE_EXECUTABLE_PATH` is set; Linux CI uses Xvfb.
- `npm run package`: build and create a VSIX. The manual [publishing workflow](.github/workflows/publish.yml) validates it and uses Marketplace Trusted Publishing; see [release instructions](CONTRIBUTING.md#publishing).

The VS Code launch configuration builds before starting the extension development host. For manual or visual testing, use **Start Debugging** (F5) with **Run APM Extension**, or click **Run APM Extension** in the status bar; this launches the development host with the workspace extension enabled. The [workspace settings](.vscode/settings.json) disable the experimental Debug Network view to avoid a Node inspector crash on extension-host reload; in a multi-root workspace, set `debug.javascript.enableNetworkView` to `false` at workspace level. Do not use `npm run test:extension` to inspect the normal Extensions view or other installed extensions: its isolated test host deliberately passes `--disable-extensions` and uses a temporary profile. See the [test guidance](test/AGENTS.md) for optional real-CLI tests.

On macOS, do not launch ad hoc GUI test instances with a redirected `HOME`: they can display a Keychain Not Found prompt. Never reset or modify the user's keychain.

## Boundaries

- Preserve Workspace Trust checks, command confirmation, output redaction, metadata path containment, and webview sanitization and content security policy.
- Keep new compile, audit, doctor, target, preview, and script execution explicit. Completion and task discovery must not run APM or make network requests. Preserve existing refresh/settings synchronization.
- Expose focused VS Code actions, not a generic CLI browser. Collect parameters with native pickers/inputs; route findings to Problems, previews to read-only editors, and scripts/watch to tasks. Do not restore APM Tools or install target overrides.
- Use non-modal VS Code notifications for confirmations, warnings, errors, and privacy guidance. Preserve explicit mutation approval; do not use modal dialogs or webview notification banners. Keep operation results and audit findings in context.
- Capture operation scope before asynchronous work. Keep preview/apply options aligned, validate file links on the host, and never map decoded audit offsets directly to physical source lines.
- Keep global and current-workspace installations distinct by package identity and scope. List global packages without a workspace manifest; ask for installation destinations independently of scope filters, and retain update/uninstall/preview-apply scope.
- Do not assign a normative subset schema to schema-less APM working-draft manifests. Script tasks require `apm.tasks.includeScripts` and user confirmation.
- Keep credentials out of settings, source URLs, fixtures, and logs. Use VS Code Accounts for GitHub via [the authentication adapter](src/authentication.ts); preserve APM authentication fallback and mask injected tokens. Request sign-in only after an explicit user action. Ask before CLI installation, upgrades, or destructive mutations.
- Route remote metadata through repository-scoped authentication; approve custom HTTPS hosts explicitly and store owned tokens only in SecretStorage. Preserve [CLI authentication compatibility gates](src/auth/cli.ts): do not retry mutations with another account or assume a global token supports mixed-account dependencies.
- When anonymous repository access is rate-limited, try already-authorized accounts with verified access. Do not persist a binding from an inconclusive anonymous probe or rotate accounts after an authenticated rate limit.
- Reuse automatic remote checks, including failures, for five minutes; explicit Refresh bypasses the cache. Invalidate update results after package mutations to preserve verification. Cache only read-only access probes; CLI credential selection must probe access freshly.
- Treat `dist/`, `node_modules/`, `apm_modules/`, `.agents/skills/`, and APM lockfiles as generated or CLI-managed. Do not hand-edit them; update `package-lock.json` through npm.
- Commit APM-deployed agent files, including `.agents/skills/`, alongside `apm.yml` and `apm.lock.yaml`. Keep the `apm_modules/` dependency cache gitignored.
- The [CLI contract](src/apm/contract.json) is generated by [`scripts/sync-contract.py`](scripts/sync-contract.py), not hand-maintained.
- APM can generate distributed `AGENTS.md` files. Preview with `apm compile --dry-run` before compiling so hand-authored guidance is not inadvertently changed.
- Pin GitHub Actions to full commit SHAs. The release workflow must rerun CI and publish its validated VSIX using OIDC.
- Update the relevant agent guidance when changing commands or project-wide behavior.
