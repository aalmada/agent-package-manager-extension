# APM user guide

APM for VS Code is a visual interface for [Microsoft Agent Package Manager](https://microsoft.github.io/apm/). It lets you browse and manage APM packages from VS Code. This extension is independent and is not affiliated with or published by Microsoft.

## Features

- Browse package catalogs, installed packages, and available updates.
- Search and filter controls stay fixed at the top of the package browser. **Catalog**, **Installed**, and **Updates** have collapsible headers with right-aligned item-count badges. Drag the separators between package sections to resize them, or focus a separator and use the arrow keys. Sizes and collapse state are saved. These sections use a custom webview layout to keep search fixed; there is no draggable Search section.
- The top-right toolbar has **Refresh** and the native **…** menu. Open **Views** to toggle **Catalog**, **Installed**, and **Updates**; visibility is saved per workspace independently of search filters. **Settings** is in the same menu.
- Refresh progress uses VS Code's native view indicator, without in-page working banners or cancel-refresh buttons.
- Automatic refreshes reuse remote marketplace and package-update checks for five minutes, including failed checks, while still reloading installed packages locally. Successful CLI version/help probes are also reused per scope for five minutes; **Refresh**, executable-setting changes, and CLI installation/upgrades invalidate those probes. Scans skip `apm deps list` when no package cache exists and read local marketplace manifests without an APM update call. Watcher events are debounced and pending events are consumed by command-triggered refreshes. **Refresh** fetches immediately; account changes clear remote cached results, and package mutations force a fresh update check for their scope so updates are still verified.
- Marketplace packages show update status as soon as the catalog loads by comparing installed and catalog semantic versions. `apm outdated` then refines it during the same refresh, after marketplace updates finish; a definitive APM result replaces the catalog comparison, while an unknown or missing APM result keeps it. Catalog entries from a failed marketplace refresh are not used for comparison.
- Confirmations, warnings, errors, and privacy guidance use non-modal VS Code notifications, not modal dialogs or webview notification banners. Mutations still require explicit approval through notification actions; dismissing a confirmation makes no changes. Repeated refresh warnings are suppressed until they change or clear.
- The APM Activity Bar badge counts global and current-workspace package updates, regardless of search filters, plus one when the CLI compatibility check recommends an APM upgrade. It disappears when there are no updates, the CLI is unavailable, or the workspace is untrusted. Saved package update results remain counted and are identified in the badge tooltip.
- Recognize lockfile-recorded standalone skills, skill bundles, and marketplace plugins even when the package cache is absent and the CLI omits them. Recovery verifies deployed content files and active ownership locally, without private-repository authentication. Details show only that package's deployed contents; a manifest, stale lock entry, or leftover reference files alone do not count as installed.
- View package details, including skills, agents, instructions, prompts, Copilot extensions, and available documentation. For awesome-copilot plugins, contents declared for its published build are resolved from the repository and labelled, because APM installs only the plugin's manifest and README from its source folder.
- Browse global installations and updates alongside the current workspace, even without an `apm.yml`. Catalog entries show **Installed globally** and **Installed in workspace** independently. A package installed in both scopes has separate Installed/Updates entries tagged **Global** and **Workspace**, each with its own version, status, and scope-bound actions.
- Install packages to an initialized workspace or to your global user scope. Installation and install previews first ask for a destination, defaulting to an initialized workspace when available, otherwise global. Package pages offer **Install in…** for another scope and links to each existing installation.
- Run package actions directly from a package's page: **Install**, **Update**, **Uninstall**, **Install version…** (pick a tag, branch, or ref), and **Audit**. Installation and previews leave target selection to APM and the project's `apm.yml`; they do not pass target overrides. Install, update, and uninstall ask for confirmation first. Progress, a summary, any audit findings, and the command output appear on the page, where you can cancel a running action. If a package's MCP server needs a value, VS Code asks for it in an input box and hides every answer for privacy. Verbatim echoes of entered values are redacted from captured output; APM uses them to configure the MCP server. Values already set as environment variables are used without asking. Full logs are in the **APM** output channel.
- **Update** advances tag-based packages to the latest tag reported by APM, using `apm install <package>#<tag>` to change the manifest pin after confirmation. Other packages use `apm update`. The extension checks the refreshed package status and reports an unverified or still-outdated result instead of treating a zero exit code as a verified upgrade.
- Manage APM marketplaces and supported CLI settings through VS Code Settings.
- Use focused Command Palette actions with native VS Code pickers, input boxes, progress, Problems, and tasks instead of generic CLI command forms.
- Work in desktop VS Code and Remote Development environments such as SSH, WSL, and dev containers.

## Native actions

The extension integrates common package and project operations, not the entire CLI command set. Advanced registry publishing and other CLI-only operations remain in the terminal.

- **Initialize a project:** choose **APM: Initialize Project** and enter its name in native VS Code inputs. Only the name is required; version, description, and author are optional and use APM defaults when left blank. Select target harnesses in a multi-select picker, or leave the selection empty for APM auto-detection, then review all values before creation. APM writes the manifest in the selected workspace folder without opening a terminal wizard or creating a nested project. An existing manifest opens for editing instead of being overwritten.
- **Install a package:** choose **APM: Install Package**, choose the destination, select a catalog package or enter its source/ref, then confirm. Initialize a workspace first to make it an installation destination. Package pages retain previews, version selection, updates, and uninstall actions. Target selection stays in `apm.yml`.
- **Compile or validate:** focused actions execute directly with cancellable progress. Compilation previews open in read-only text editors; validation reports completion or an explicit failure with Output access.
- **Watch compilation:** use **Tasks: Run Task** to select the APM watch task. It runs without a time limit and does not hold up the extension's package-action or settings-sync queue.
- **Stop a task:** use **Tasks: Terminate Task**. Task output stays in its terminal; logs for native actions remain in the **APM** output channel.
- **Review audit coverage:** package audit results show incomplete-scan diagnostics separately from findings, including available source or decoded-prompt locations and remediation. Incomplete coverage is not shown as a clean audit.
- **Manage lifecycle scripts:** **APM: Manage Lifecycle Workflows** lists and validates discovered scripts, dry-runs or explicitly executes one of APM's six lifecycle events, manages project trust, and adds or replaces the starter block. Script execution and lifecycle changes require confirmation.
- **Review dependencies and export an SBOM:** **APM: Dependency Reports** runs an explicit outdated-dependency check or generates CycloneDX/SPDX output from the workspace or global lockfile. View the report in a read-only editor or save an SBOM through the native file picker; saving requires confirmation.

Dedicated VS Code settings mirror the supported subset of CLI configuration. Configure other keys with the APM CLI. Manifest-driven features such as LSP declarations, lifecycle definitions, and replacement rules remain managed by APM; edit the manifest and run the relevant action.

## Native workspace workflows

- **Filter by scope:** use **Scope** in the funnel filter menu or type `@scope:workspace` / `@scope:global`. Selecting the active scope filter again clears it to show both. Workspace selection also chooses the current folder in multi-root workspaces. Filters do not select an installation destination; the install picker does. Package details show their scope and execution host. Project actions invoked from a manifest use that manifest's workspace folder; otherwise they use the current folder or ask for a project. Running actions and applied previews retain their original scope.
- **Find APM workflows:** open **More APM actions** from the **...** menu at the top right of the Agent Package Manager view to find dependency reports and explanations, file ownership, executable trust and policy, marketplace health, MCP discovery/installation, and lifecycle workflows. The Command Palette also exposes their individual **APM:** commands. Project actions require a trusted workspace. Settings and refresh stay in the view toolbar, output is available in the **APM** output channel and error actions, and target explanations are contextual recovery actions, not palette commands. There is no generic Run Command launcher or APM Tools page.
- **Preview before changing packages:** package pages offer installation/update previews and version previews. APM's dry-run output is the plan, not a promised file-by-file diff. Offline plans can be incomplete, and resolution can change before applying. **Review and apply preview options** reuses those options but still asks for confirmation.
- **Inspect content:** available local source and installed-content links open verified files. Content absent from local metadata remains listed without a fabricated link.
- **Browse dependencies:** choose **Dependencies** in the browser's funnel menu or type `@dependencies` to group **Direct dependencies**, **Transitive dependencies**, and, when needed, **Unclassified dependencies** under **Installed** in the Agent Package Manager view. Search, marketplace filters, sorting, scope selection, and package navigation still work. **Back to packages** exits this mode. Choose **View dependency tree** for the selected scope, or **Explain dependency** on an installed package to inspect its APM dependency paths.
- **Find file owners:** use **APM: Find File Owner** from the Explorer/editor context menu or Command Palette to trace the active or selected file with `apm find`; APM only identifies files it tracks.
- **Review executable trust:** **APM: Review Executable Trust** opens policy status, pending approvals, or effective decisions for a selected project. **APM: Explain Package Policy** shows a package's effective decision. **APM: Manage Executable Trust** keeps workspace/global package identity distinct and lets you approve or deny primitives in shared `apm.yml` policy or personal APM configuration. Every approval or denial requires confirmation.
- **Check marketplace health:** **APM: Check Marketplace Health** runs marketplace entry checks, outdated-package reports, marketplace validation, or dependency audits. Online and offline variants are labeled separately; reports stay in read-only documents, including findings returned with a nonzero exit code.
- **Discover MCP servers:** **APM: Discover MCP Servers** lists, searches, or shows details for servers in the configured registry. Each lookup is explicit and cancellable; results, including nonzero reports, open in read-only documents.
- **Install an MCP server:** **APM: Install MCP Server** asks for a destination independently of the package-scope filter, accepts an exact registry name, and requires confirmation before APM changes the selected workspace or global configuration.
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
4. Browse the catalog and global installations immediately. Choose **Initialize APM project** to enable workspace installation if the current folder has no manifest. The filter (funnel) menu can narrow the lists to workspace or global installations.
5. Open **APM: Open Marketplace Settings** and add a marketplace source.
6. Browse the Catalog, select a package to view its details, and choose **Install**.

If you installed an earlier development VSIX with the identifier `apm-local.apm-package-manager`, uninstall it before installing the Marketplace version to avoid duplicate views and commands.

Marketplace sources can be repository shorthands such as `owner/repo`, Git URLs, marketplace JSON URLs, or local paths. APM validates and registers sources. For Remote Development, the CLI and marketplace paths must be available on the remote host.

For private repositories, run **APM: Manage Repository Accounts**. Choose a configured marketplace, known repository, or remote dependency in the selected scope, or enter another repository. Local lockfile entries, including synthetic `_local/` identities, do not contribute authentication repositories. The list is assembled locally without checking access until you choose a credential. Direct GitHub package paths use the parent repository's credentials; an authentication failure offers account management for that repository. A marketplace can reference plugins in another repository requiring a different account. The extension supports GitHub.com, explicitly approved GitHub Enterprise and self-managed hosts, GitLab, and Azure DevOps for remote package contents and README.

- **GitHub accounts:** use **APM: Sign in to GitHub** to authorize repository access through VS Code Accounts. The extension silently tests already-authorized accounts for each repository, starting with the remembered selection and looking up other accounts' sessions only when it is denied. Background refresh never prompts for sign-in or consent.
- **Request limits:** known private repositories use their selected credentials directly instead of retrying anonymously for every metadata file. When anonymous requests are rate-limited, the extension silently checks existing accounts for repository access before using them. If none can be verified, connect an account or wait until the reset time shown when available. Read-only access probes are reused for five minutes and cleared when accounts or tokens change. Repositories that refuse anonymous access skip repeated anonymous probes for five minutes. CLI credential selection performs fresh access probes before execution; within one refresh, each repository is verified once and reused by that refresh's read-only APM commands. Installs, updates, and other mutations always verify fresh.
- **Personal access tokens:** enter tokens only through the masked input in **APM: Manage Repository Accounts**. Owned tokens are repository-scoped and stored in VS Code SecretStorage, never settings, marketplace URLs, or project files. Use GitHub repository read access, GitLab `read_api` and `read_repository`, or Azure DevOps Code (Read) as appropriate; grant organization SSO access where required.
- **Enterprise and self-managed services:** explicitly choose the service type and approve its HTTPS origin before adding a credential. To reuse VS Code Enterprise accounts, configure `github-enterprise.uri` for that origin; otherwise use a repository-scoped PAT. GitHub.com account tokens are not sent to another host. Existing SSH aliases are not automatically treated as HTTPS API hosts.
- **Switching and removal:** use the management command to change a repository's selection or remove an owned token. This does not sign out an account in VS Code Accounts or revoke a token at its provider. Session changes invalidate cached authentication and reload open package details; running processes retain their existing environment.
- **WSL and other remote hosts:** account bindings are partitioned by extension host. SecretStorage is managed by VS Code; do not assume it is a separate WSL-only credential vault. The APM executable and existing Git/SSH authentication still belong to the remote host.

### CLI authentication compatibility

Separate marketplace registrations and refreshes can use different credentials, including two repositories in the same organization. Remote contents, descriptions, and README use the actual plugin repository's credentials.

APM 0.35.0 does not provide an enforceable repository-credential hook across its entire resolver. The extension therefore blocks operations requiring conflicting credentials before starting the CLI, rather than retrying an install or update with another account after files may have changed. One GitHub account can cover multiple declared repositories. Resolver operations with saved bindings outside their known repository context, mixed origins, or unsupported credential types are gated conservatively. Full mixed-account installs, updates, and transitive dependency resolution require upstream APM support; a newer version number alone does not remove this limitation.

To opt into the isolated private direct-install test, set `APM_TEST_EXECUTABLE` to APM 0.35.0, `APM_PRIVATE_TEST_SOURCE` to a private GitHub.com package source, and `APM_PRIVATE_TEST_TOKEN` to a token with access; then run `npx tsx --test test/apm/privateLive.test.ts`. The test writes to a temporary home and project and performs a real installation. Never commit the token.

Local workflows such as compilation and task discovery do not need repository tokens. Project script tasks do not receive extension-owned repository credentials; they retain their existing environment and Git/SSH authentication. Discovery and completion do not run authentication probes or network requests.

A private repository can return a misleading **No marketplace.json found** error when access is missing. Sign in, grant any organization SSO access required, and retry. If it persists, verify the repository contains one of APM's supported marketplace manifests. A `#ref` pinning warning is separate from authentication.

Do not include credentials in HTTP(S) URLs or passwords in other URLs; use VS Code Accounts, the repository account manager, or existing APM authentication. Unmanaged sources retain APM's existing environment and CLI authentication fallback. Other Git hosts retain CLI/SSH support, but do not gain arbitrary-host remote contents browsing. The extension will not copy an existing APM marketplace registration containing URL credentials into VS Code settings. Remove or replace that registration in APM before syncing marketplaces.

Remote README images are blocked by default to avoid contacting third-party image hosts when a package page opens. To allow HTTPS images, enable **APM: Allow Remote Images** in VS Code Settings on the APM host. Image hosts can then see your network address and that you opened the documentation. Insecure HTTP and protocol-relative images remain blocked.

## APM version compatibility

The native actions target APM 0.35.0. Older versions receive compatibility checks, and unsupported commands or options are reported. A newer version is not assumed to be compatible just because its version number is higher.

Use **Update APM** in a compatibility notification or **APM: Install or Upgrade CLI** in the Command Palette to upgrade the CLI. The package browser does not display a CLI-version or update-timestamp footer.

Package lists support the CLI's Unicode and ASCII tables. Malformed rows and truncated package identities are reported rather than guessed.

The extension uses APM to resolve, install, update, and remove packages. Review the selected package and operation before confirming changes.
