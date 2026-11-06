# APM for Visual Studio Code

APM for VS Code is a visual interface for [Microsoft Agent Package Manager](https://microsoft.github.io/apm/). It lets you browse and manage APM packages from VS Code. This extension is independent and is not affiliated with or published by Microsoft.

## Features

- Browse package catalogs, installed packages, and available updates.
- Search and filter controls stay fixed at the top of the package browser. **Catalog**, **Installed**, and **Updates** have collapsible headers with right-aligned item-count badges. Drag the separators between package sections to resize them, or focus a separator and use the arrow keys. Sizes and collapse state are saved. These sections use a custom webview layout to keep search fixed; there is no draggable Search section.
- The top-right toolbar has **Refresh** and the native **…** menu. Open **Views** to toggle **Catalog**, **Installed**, and **Updates**; visibility is saved per workspace independently of search filters. **Settings** is in the same menu.
- Refresh progress uses VS Code's native view indicator, without in-page working banners or cancel-refresh buttons.
- Confirmations, warnings, errors, and privacy guidance use non-modal VS Code notifications, not modal dialogs or webview notification banners. Mutations still require explicit approval through notification actions; dismissing a confirmation makes no changes. Repeated refresh warnings are suppressed until they change or clear.
- The APM Activity Bar badge counts package updates in the selected scope, regardless of search filters, plus one when the CLI compatibility check recommends an APM upgrade. It disappears when there are no updates, the CLI is unavailable, or the workspace is untrusted. Saved package update results remain counted and are identified in the badge tooltip.
- Recognize standalone skills recorded in the lockfile when their deployed `SKILL.md` still exists, even if an older CLI omits them from its package listing. Their details show the deployed contents; a manifest or stale lock entry alone does not count as installed.
- View package details, including skills, agents, instructions, prompts, Copilot extensions, and available documentation. For awesome-copilot plugins, contents declared for its published build are resolved from the repository and labelled, because APM installs only the plugin's manifest and README from its source folder.
- Install packages to a workspace or to your global user scope.
- Run package actions directly from a package's page: **Install**, **Update**, **Uninstall**, **Install version…** (pick a tag, branch, or ref), and **Audit**. Installation and previews leave target selection to APM and the project's `apm.yml`; they do not pass target overrides. Install, update, and uninstall ask for confirmation first. Progress, a summary, any audit findings, and the command output appear on the page, where you can cancel a running action. If a package's MCP server needs a value, VS Code asks for it in an input box and hides every answer for privacy. Verbatim echoes of entered values are redacted from captured output; APM uses them to configure the MCP server. Values already set as environment variables are used without asking. Full logs are in the **APM** output channel.
- **Update** advances tag-based packages to the latest tag reported by APM, using `apm install <package>#<tag>` to change the manifest pin after confirmation. Other packages use `apm update`. The extension checks the refreshed package status and reports an unverified or still-outdated result instead of treating a zero exit code as a verified upgrade.
- Manage APM marketplaces and supported CLI settings through VS Code Settings.
- Use focused Command Palette actions with native VS Code pickers, input boxes, progress, Problems, and tasks instead of generic CLI command forms.
- Work in desktop VS Code and Remote Development environments such as SSH, WSL, and dev containers.

## Native actions

The extension integrates common package and project operations, not the entire CLI command set. Advanced registry publishing, lifecycle administration, and other CLI-only operations remain in the terminal.

- **Initialize a project:** choose **APM: Initialize Project** and enter its name in native VS Code inputs. Only the name is required; version, description, and author are optional and use APM defaults when left blank. Select target harnesses in a multi-select picker, or leave the selection empty for APM auto-detection, then review all values before creation. APM writes the manifest in the selected workspace folder without opening a terminal wizard or creating a nested project. An existing manifest opens for editing instead of being overwritten.
- **Install a package:** choose **APM: Install Package**, select a catalog package or enter its source/ref, then confirm. Package pages retain previews, version selection, updates, and uninstall actions. Target selection stays in `apm.yml`.
- **Compile or validate:** focused actions execute directly with cancellable progress. Compilation previews open in read-only text editors; validation reports completion or an explicit failure with Output access.
- **Watch compilation:** use **Tasks: Run Task** to select the APM watch task. It runs without a time limit and does not hold up the extension's package-action or settings-sync queue.
- **Stop a task:** use **Tasks: Terminate Task**. Task output stays in its terminal; logs for native actions remain in the **APM** output channel.
- **Review audit coverage:** package audit results show incomplete-scan diagnostics separately from findings, including available source or decoded-prompt locations and remediation. Incomplete coverage is not shown as a clean audit.

Dedicated VS Code settings mirror the supported subset of CLI configuration. Configure other keys with the APM CLI. Manifest-driven features such as LSP declarations, lifecycle definitions, and replacement rules remain managed by APM; edit the manifest and run the relevant action.

## Native workspace workflows

- **Choose the destination:** use **Scope** in the funnel filter menu to select a workspace or global user scope. Package details show their scope and execution host. Project actions invoked from a manifest use that manifest's workspace folder; otherwise they use the selected scope or ask for a project. Running actions retain their original scope.
- **Use direct actions:** the Command Palette includes initialization, package installation, compilation/preview, validation, workspace audit, health checks, and opted-in project scripts. Project actions appear only with a trusted workspace. Settings and refresh stay in the view toolbar, output is available in the **APM** output channel and error actions, and target explanations are contextual recovery actions, not palette commands. There is no generic Run Command launcher or APM Tools page.
- **Preview before changing packages:** package pages offer installation/update previews and version previews. APM's dry-run output is the plan, not a promised file-by-file diff. Offline plans can be incomplete, and resolution can change before applying. **Review and apply preview options** reuses those options but still asks for confirmation.
- **Inspect content:** available local source and installed-content links open verified files. Content absent from local metadata remains listed without a fabricated link.
- **Browse dependencies:** choose **Dependencies** in the browser's funnel menu or type `@dependencies` to replace the regular sections with **Direct dependencies**, **Transitive dependencies**, and, when needed, **Unclassified dependencies**. Search, marketplace filters, sorting, scope selection, and package navigation still work. **Back to packages** exits this mode. Package pages link to **View workspace dependencies** or **View global dependencies** for their captured scope, not a package-specific tree: parent-child relationships are not available. These sections share the browser's refreshed package data without running an extra tree query.
- **Act on audits:** workspace audits open **Problems**; package audits also show their findings on the package page. Findings in decoded structured prompts open a read-only decoded document rather than mislabeling a physical source line. Incomplete coverage remains a warning, not a clean scan. Editing an affected document invalidates stale Problems entries.
- **Recover in context:** errors offer output and relevant doctor, authentication, target, or policy guidance. Retry uses the original operation and scope and repeats mutation confirmation. Doctor can make a network probe; it does not install or repair anything automatically.

### Manifest editing

The manifest editor offers local field/target completion, field documentation, dependency source links, and explicit CLI validation actions. It uses existing YAML support when available and does not require another language server. Local syntax diagnostics yield to an active Red Hat YAML extension.

Schema-less manifests use APM's working draft. The extension does not assign a published OpenAPM subset schema to every manifest, change a project's contract, or claim complete schema validation. An explicit `$schema` remains authoritative; CLI support and the selected schema must agree. Completion and hover do not run APM or make network requests. Validate/compile/audit commands run only after an explicit user action.

### Reusable tasks

**Tasks: Run Task** discovers APM compile, watch, validation, and CI-audit workflows from workspace manifests without executing the CLI during discovery. Saved tasks can use:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "APM: validate",
      "type": "apm",
      "workflow": "validate"
    }
  ]
}
```

Supported `workflow` values are `compile`, `watch`, `validate`, `audit`, and `script`. A script task also specifies `"script": "name"`. Script discovery/execution requires **APM: Tasks: Include Scripts** (`apm.tasks.includeScripts`, off by default), an explicit run and confirmation, and APM's experimental script support. When opted in, **APM: Run Script** offers a native picker of manifest scripts and starts the chosen task. Interactive scripts run in their own process-task terminal. Tasks validate CLI capabilities at execution time; built-in workflows stream through a managed task terminal so discovery stays offline and output stays redacted.

No task is configured to run on folder open. Stop tasks with **Tasks: Terminate Task**; extension disposal stops only its own active work. Compilation and script tasks can change project files, so inspect the project and use compilation preview when appropriate.

## Requirements

- Visual Studio Code 1.96 or later.
- The APM CLI in the environment where VS Code runs APM. The extension does not bundle the CLI; use **APM: Install or Upgrade CLI** or set `apm.executablePath` if needed.
- A trusted workspace. The extension requires Workspace Trust before it runs APM or reads package sources.

Virtual workspaces and browser-only VS Code are not supported because they cannot run the APM CLI.

## Install and get started

1. Install [APM - Agent Package Manager](https://marketplace.visualstudio.com/items?itemName=antao-almada.apm-package-manager) from the VS Code Marketplace, or use **Extensions: Install from VSIX**.
2. Open and trust a workspace, then select the **APM** icon in the Activity Bar.
3. If APM is not available, the Packages view shows a welcome message instead of package lists. Choose **Install APM CLI**, use **APM: Install or Upgrade CLI**, or configure `apm.executablePath`. Refresh the view after installing APM outside the extension.
4. If the selected project is not initialized, the view shows **Initialize APM project** instead of package lists. Initialize it to reveal the package browser. In the browser, use the filter (funnel) button to choose a workspace folder or **Global (user)** as the package scope.
5. Open **APM: Open Marketplace Settings** and add a marketplace source.
6. Browse the Catalog, select a package to view its details, and choose **Install**.

If you installed an earlier development VSIX with the identifier `apm-local.apm-package-manager`, uninstall it before installing the Marketplace version to avoid duplicate views and commands.

Marketplace sources can be repository shorthands such as `owner/repo`, Git URLs, marketplace JSON URLs, or local paths. APM validates and registers sources. For Remote Development, the CLI and marketplace paths must be available on the remote host.

For private GitHub repositories, run **APM: Sign in to GitHub** and authorize the extension through VS Code's Accounts menu. The extension requests repository access and uses the authorized account for APM commands, tasks, and GitHub package metadata. Sign-in retries failed marketplace settings; existing authorized sessions are reused without prompting during background refreshes. Credentials are passed only in process environments or HTTPS authorization headers, never saved in settings or marketplace URLs. Signing out or changing Accounts access takes effect on subsequent operations; already-running processes retain their environment.

A private repository can return a misleading **No marketplace.json found** error when access is missing. Sign in, grant any organization SSO access required, and retry. If it persists, verify the repository contains one of APM's supported marketplace manifests. A `#ref` pinning warning is separate from authentication.

Do not include credentials in HTTP(S) URLs or passwords in other URLs; use VS Code Accounts for GitHub or APM authentication for other hosts. Without an authorized VS Code GitHub session, APM's existing environment and CLI authentication remain available. The extension will not copy an existing APM marketplace registration containing URL credentials into VS Code settings. Remove or replace that registration in APM before syncing marketplaces.

Remote README images are blocked by default to avoid contacting third-party image hosts when a package page opens. To allow HTTPS images, enable **APM: Allow Remote Images** in VS Code Settings on the APM host. Image hosts can then see your network address and that you opened the documentation. Insecure HTTP and protocol-relative images remain blocked.

## APM version compatibility

The native actions target APM 0.35.0. Older versions receive compatibility checks, and unsupported commands or options are reported. A newer version is not assumed to be compatible just because its version number is higher.

Use **Update APM** in a compatibility notification or **APM: Install or Upgrade CLI** in the Command Palette to upgrade the CLI. The package browser does not display a CLI-version or update-timestamp footer.

Package lists support the CLI's Unicode and ASCII tables. Malformed rows and truncated package identities are reported rather than guessed.

The extension uses APM to resolve, install, update, and remove packages. Review the selected package and operation before confirming changes.
