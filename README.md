# APM for Visual Studio Code

APM for VS Code is a visual interface for [Microsoft Agent Package Manager](https://microsoft.github.io/apm/). It lets you browse and manage APM packages from VS Code. This extension is independent and is not affiliated with or published by Microsoft.

## Features

- Browse package catalogs, installed packages, and available updates.
- Recognize standalone skills recorded in the lockfile when their deployed `SKILL.md` still exists, even if an older CLI omits them from its package listing. Their details show the deployed contents; a manifest or stale lock entry alone does not count as installed.
- View package details, including skills, agents, instructions, prompts, Copilot extensions, and available documentation. For awesome-copilot plugins, contents declared for its published build are resolved from the repository and labelled, because APM installs only the plugin's manifest and README from its source folder.
- Install packages to a workspace or to your global user scope.
- Run package actions directly from a package's page: **Install**, **Update**, **Uninstall**, **Install version / target…** (pick a tag, branch, or ref and target harnesses), **Audit**, and **Dependency tree**. Install, update, and uninstall ask for confirmation first. Progress, a summary, any audit findings, and the command output appear on the page, where you can cancel a running action. If a package's MCP server needs a value, VS Code asks for it in an input box and hides every answer for privacy. Verbatim echoes of entered values are redacted from captured output; APM uses them to configure the MCP server. Values already set as environment variables are used without asking. Full logs are in the **APM** output channel.
- Manage APM marketplaces and supported CLI settings through VS Code Settings.
- Run any other APM command (compile, audit, init, deps, mcp, pack, run, config, ...) through guided forms with **APM: Run Command...** from the Command Palette.
- Work in desktop VS Code and Remote Development environments such as SSH, WSL, and dev containers.

## Requirements

- Visual Studio Code 1.96 or later.
- The APM CLI in the environment where VS Code runs APM. The extension does not bundle the CLI; use **APM: Install or Upgrade CLI** or set `apm.executablePath` if needed.
- A trusted workspace. The extension requires Workspace Trust before it runs APM or reads package sources.

Virtual workspaces and browser-only VS Code are not supported because they cannot run the APM CLI.

## Install and get started

1. Install [APM - Agent Package Manager](https://marketplace.visualstudio.com/items?itemName=antao-almada.apm-package-manager) from the VS Code Marketplace, or use **Extensions: Install from VSIX**.
2. Open and trust a workspace, then select the **APM** icon in the Activity Bar.
3. If APM is not available, use **APM: Install or Upgrade CLI** or configure `apm.executablePath`.
4. Use the filter (funnel) button in the Packages view to choose a workspace folder or **Global (user)** as the package scope.
5. Open **APM: Open Marketplace Settings** and add a marketplace source.
6. Browse the Catalog, select a package to view its details, and choose **Install**.

If you installed an earlier development VSIX with the identifier `apm-local.apm-package-manager`, uninstall it before installing the Marketplace version to avoid duplicate views and commands.

Marketplace sources can be repository shorthands such as `owner/repo`, Git URLs, marketplace JSON URLs, or local paths. APM validates and registers sources. For Remote Development, the CLI and marketplace paths must be available on the remote host.

Do not include credentials in HTTP(S) URLs or passwords in other URLs; use APM authentication instead. The extension will not copy an existing APM marketplace registration containing URL credentials into VS Code settings. Remove or replace that registration in APM before syncing marketplaces.

Remote README images are blocked by default to avoid contacting third-party image hosts when a package page opens. To allow HTTPS images, enable **APM: Allow Remote Images** in VS Code Settings on the APM host. Image hosts can then see your network address and that you opened the documentation. Insecure HTTP and protocol-relative images remain blocked.

## APM version compatibility

The visual command forms target APM 0.35.0. Older versions receive compatibility checks, and unsupported commands or options are disabled or reported. A newer version is not assumed to be compatible just because its version number is higher.

Package lists support the CLI's Unicode and ASCII tables. Malformed rows and truncated package identities are reported rather than guessed.

The extension uses APM to resolve, install, update, and remove packages. Review the selected package and operation before confirming changes.
