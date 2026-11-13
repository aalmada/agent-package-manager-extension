# Commands

Every extension command starts with **APM:** in the Command Palette (**View** > **Command Palette**, or `Ctrl+Shift+P` / `Cmd+Shift+P`). Many commands are also available from the APM view, context menus, the editor title bar, or **More APM Actions**. This page lists where to find each one.

## Command Palette commands

"Trusted" means the command appears only in a trusted workspace. "Folder" means it also needs an open workspace folder.

### Packages and setup

| Command | What it does | Also available from | Shown when |
| --- | --- | --- | --- |
| **APM: Install Package** | Install a catalog package or a package source. See [Install a package](managing-packages.md#install-a-package). | **Install a package** in the APM view | Always |
| **APM: Open Marketplace Settings** | Open the `apm.marketplaces` setting. See [Marketplaces](marketplaces.md). | **Add marketplace** in the APM view | Always |
| **APM: Install or Upgrade CLI** | Install or upgrade the APM CLI. See [Set up the APM CLI](getting-started.md#set-up-the-apm-cli). | **Install APM CLI** in the APM view; **Update APM** in compatibility notifications | Always |
| **APM: Run Doctor** | Run `apm doctor` and open the health check in a read-only document. | **Run Doctor** in error notifications | Always |
| **APM: Sign in to GitHub** | Authorize a GitHub account through VS Code Accounts. See [Private repositories](private-repositories.md). | Authentication error notifications | Always |
| **APM: Manage Repository Accounts** | Connect accounts, add tokens, approve hosts, or remove repository credentials. | Authentication error notifications | Always |

### Projects

| Command | What it does | Also available from | Shown when |
| --- | --- | --- | --- |
| **APM: Initialize Project** | Create `apm.yml` in a folder. See [Initialize a project](projects.md#initialize-a-project). | **Initialize APM project** in the APM view; Explorer folder context menu | Trusted, folder |
| **APM: Compile** | Run `apm compile` after confirmation. | `compile` task | Trusted, folder |
| **APM: Preview Compilation** | Open the `apm compile --dry-run` plan in read-only editors. | `apm.yml` editor title | Trusted, folder |
| **APM: Validate Manifest and Primitives** | Run `apm compile --validate`. | `apm.yml` editor title; `apm.yml` Explorer context menu; `validate` task | Trusted, folder |
| **APM: Audit Workspace** | Audit the project and publish findings to **Problems**. | `apm.yml` Explorer context menu; `audit` task | Trusted, folder |
| **APM: Run Script** | Pick and run a named manifest script as a task. See [Manifest scripts](projects.md#manifest-scripts). | **Tasks: Run Task** | Trusted, folder, `apm.tasks.includeScripts` enabled |
| **APM: Manage Lifecycle Workflows** | Inspect, test, run, and trust lifecycle scripts. See [Lifecycle workflows](projects.md#lifecycle-workflows). | More APM Actions | Trusted, folder |

### Dependencies

| Command | What it does | Also available from | Shown when |
| --- | --- | --- | --- |
| **APM: View Dependency Tree** | Open `apm deps tree` for the current scope. See [Dependencies](dependencies.md#view-the-dependency-tree). | **View dependency tree** in dependency mode; More APM Actions | Trusted |
| **APM: Explain Dependency** | Explain why an installed package is present. | **Explain dependency** on package pages; More APM Actions | Trusted |
| **APM: Find File Owner** | Find which package deployed a file. | Explorer and editor context menus; More APM Actions | Trusted, folder |
| **APM: Dependency Reports** | Check outdated dependencies, or view or save an SBOM. | More APM Actions | Trusted |

### Trust, marketplaces, and MCP

| Command | What it does | Also available from | Shown when |
| --- | --- | --- | --- |
| **APM: Review Executable Trust** | Open policy status, pending approvals, or effective trust decisions. See [Security and trust](security-and-trust.md#executable-trust-and-policy). | More APM Actions | Trusted, folder |
| **APM: Explain Package Policy** | Explain a package's effective policy decision. | **Explain Policy** in error notifications; More APM Actions | Trusted |
| **APM: Manage Executable Trust** | Approve or deny a package's executable primitives. | More APM Actions | Trusted |
| **APM: Check Marketplace Health** | Run marketplace checks, outdated reports, validation, or audits. See [Check marketplace health](marketplaces.md#check-marketplace-health). | More APM Actions | Trusted, folder |
| **APM: Discover MCP Servers** | List, search, or show servers in the MCP registry. See [MCP servers](mcp-servers.md). | More APM Actions | Trusted |
| **APM: Install MCP Server** | Install an MCP server by registry name. | More APM Actions | Trusted |
| **APM: More APM Actions** | Open the More APM Actions picker. | The APM view's **...** menu | Trusted |

## More APM Actions

**More APM Actions** groups the less frequent workflows in one searchable picker. Open it from the **...** menu at the top right of the APM view, or run **APM: More APM Actions**. It contains:

- **Dependency Reports**, **View Dependency Tree**, **Explain Dependency**, and **Find File Owner**.
- **Review Executable Trust**, **Manage Executable Trust**, and **Explain Package Policy**.
- **Check Marketplace Health**.
- **Discover MCP Servers** and **Install MCP Server**.
- **Manage Lifecycle Workflows**.

## Commands outside the Command Palette

Some commands appear only where they make sense:

| Command | Where to find it |
| --- | --- |
| **APM: Refresh** | The refresh button in the APM view toolbar. |
| **Settings** | The APM view's **...** menu. |
| **Views** > **Catalog**, **Installed**, **Updates** | The APM view's **...** menu. |
| Filters: **Installed**, **Updates**, **Dependencies**, **Scope**, **Marketplace**, **Sort By** | The filter (funnel) button next to the search box. |
| **APM: Show Output** | **Show Output** or **Show APM Output** in notifications and the CLI setup message. You can also open **View** > **Output** and select **APM**. |
| **APM: Explain Deployment Targets** | **Show Targets** in error notifications about targets. See [Deployment targets](projects.md#deployment-targets). |

## Keyboard shortcuts

The extension contributes no default keyboard shortcuts. To add one, open **Preferences: Open Keyboard Shortcuts**, search for `APM`, and assign a key. Commands hidden from the Command Palette, such as `apm.refresh`, can be bound by ID in `keybindings.json`.
