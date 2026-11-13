# Changelog

## 0.4.4

- List the extension in the Marketplace AI category.

## 0.4.3

- Use the same compact scope and status badges in Catalog, Installed, Updates, and package details, without repeating the workspace name.
- Match packages installed directly from a Git repository to their catalog entries, so Catalog shows their installation badges and every list opens the same package page.
- Show the marketplace alias currently registered with APM everywhere, including custom `name=` aliases, aliases renamed after installation, and packages installed directly from Git. Marketplace search, filter, and sort use the same name.
- Render all badges with one borderless style.

## 0.4.2

- Expand the user guide into topic pages with screenshots, covering the APM view, command, context menu, settings, and task entry points for each operation.
- Show the package browser in the Marketplace overview and describe the different ways to run operations.

## 0.4.1

- Fix discovery of installed private packages and exclude synthetic local entries from repository account selection.
- Reduce refresh and authentication overhead, show catalog update results sooner, and match APM update results case-insensitively.
- Simplify the Marketplace overview and link to the detailed user guide and introductory post.

## 0.4.0

- Add dependency tree and dependency explanation workflows, executable trust and policy management, and marketplace health checks.
- Add MCP registry discovery and installation, lifecycle workflow management, outdated dependency reports, and CycloneDX/SPDX SBOM export.
- Keep dependency categories within the Installed section and expose APM workflows through the Agent Package Manager view's **More APM Actions** menu.
- Improve dependency scope handling, package navigation, and report access.

## 0.3.0

- Show global and current-workspace installations and updates together, including global packages without a workspace manifest. Distinguish both catalog installation tags and scope-bound entries, and ask for an installation destination before package/version selection or previews.
- Debounce command/file-watcher refreshes and reuse automatic remote marketplace and update checks for five minutes, including failures, to reduce API rate-limit pressure. Explicit refresh and post-mutation update verification remain immediate.
- Reuse read-only repository access probes and authenticate known private metadata requests directly, avoiding repeated anonymous requests while preserving fresh CLI access checks.
- Use verified existing accounts when anonymous repository requests are rate-limited, and show actionable retry guidance when no account can be verified.
- Add repository-specific GitHub account selection and secure token management through **APM: Manage Repository Accounts**.
- Load private package contents and README from GitHub, GitHub Enterprise, GitLab, and Azure DevOps using repository-scoped credentials.
- Route separate marketplace operations to their selected credentials and reject mixed-account resolver operations that require unsupported upstream APM credential routing before starting the CLI.

## 0.2.1

- Default marketplace settings to NetFabric Intelligentium.

## 0.2.0

- Add native project initialization, compilation previews, manifest validation, diagnostics, and APM tasks.
- Reuse task discovery between requests and refresh it when manifests, workspace folders, or script settings change.
- Serialize catalog refreshes with marketplace mutations to avoid concurrent registry writes.
- Collect optional project metadata and deployment targets during initialization.
- Keep search and filters fixed above resizable package sections with saved layouts and item counts.
- Add a native Views menu for section visibility and checkmarks for selected view and filter options.
- Integrate direct and transitive dependency browsing into the package browser.
- Use native progress indicators and non-modal notifications for confirmations, warnings, and errors.
- Add GitHub sign-in integration and refresh package sources when authentication changes.
- Improve package update verification, standalone skill discovery, and package content navigation.
- Replace the generic package icon with a plug-and-spark design.

## 0.1.0

- Browse APM catalogs, installed packages, and updates in a dedicated VS Code view.
- View package contents and documentation, and run package actions from editor tabs.
- Manage marketplaces and supported APM configuration through native VS Code Settings.
- Run APM commands through guided forms, with workspace trust checks and confirmation for changes.
- Protect prompted values and credentials, and block remote README images by default.
