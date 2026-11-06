# Changelog

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
