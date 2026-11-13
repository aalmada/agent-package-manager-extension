# APM for Visual Studio Code

Browse, install, and update AI agent packages without leaving VS Code.

APM for VS Code provides a visual interface for [Microsoft Agent Package Manager](https://microsoft.github.io/apm/), helping you manage skills, agents, instructions, prompts, and plugins for your coding tools.

This is an independent extension, not affiliated with or published by Microsoft.

## What you can do

- **Find packages:** browse marketplaces, search and filter packages, and explore their contents and documentation.
- **Manage installations:** install, update, or remove packages in your workspace or global user scope. Preview changes and choose specific versions.
- **Keep packages current:** see installed packages and available updates together, with separate workspace and global views.
- **Work with private repositories:** connect GitHub accounts or use securely stored, repository-scoped access tokens.
- **Manage APM projects:** initialize projects, edit manifests with completion and hover help, and run compilation, validation, and audits.
- **Explore more workflows:** inspect dependencies, export SBOMs, manage executable trust, check marketplace health, and discover MCP servers.

## Get started

1. Install the extension and open a trusted workspace.
2. Select the **APM** icon in the Activity Bar.
3. If prompted, choose **Install APM CLI**, or configure an existing executable with `apm.executablePath`.
4. Browse the catalog. To add a marketplace, run **APM: Open Marketplace Settings** from the Command Palette.
5. Select a package and choose **Install**, then pick a workspace or global destination and confirm.

For workspace installations, initialize the project first with **APM: Initialize Project** if it has no APM manifest.

Use the view's **...** menu for **More APM actions**, or find individual **APM:** commands in the Command Palette.

## Private repositories

Run **APM: Sign in to GitHub** or **APM: Manage Repository Accounts** to connect an account or add a token. Grant organization SSO access if your repository requires it.

Tokens are stored in VS Code SecretStorage, not project files or settings. Background refresh never prompts you to sign in. Operations that need conflicting repository credentials may be blocked by APM's authentication limitations.

## Requirements

- **VS Code 1.96 or later**, running on desktop or through Remote Development (SSH, WSL, or dev containers).
- **APM CLI**, installed on the host where the extension runs. The extension targets APM 0.35.0 and checks command compatibility.
- **Workspace Trust** before running APM or reading package sources.

Browser-only VS Code and virtual workspaces are not supported. Package changes require confirmation; APM handles package resolution and installation.

## Learn more

- [APM, Now with a VS Code Interface | Antão Almada](https://antaoalmada.dev/posts/APM-Now-with-a-VS-Code-Interface/).
- [User guide](docs/user-guide.md): detailed workflows, settings, authentication, and troubleshooting.
- [APM documentation](https://microsoft.github.io/apm/).
- [Report an issue](https://github.com/aalmada/agent-package-manager-extension/issues).
- [Contributing](CONTRIBUTING.md).
