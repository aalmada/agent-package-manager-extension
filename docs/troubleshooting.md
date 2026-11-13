# Troubleshooting

Start with the error notification: it offers recovery actions for the problem it reports. For more detail, check the **APM** output channel or run **APM: Run Doctor**.

## Recovery actions

Error notifications offer only the actions relevant to the error:

| Action | What it does |
| --- | --- |
| **Show APM Output** | Opens the **APM** output channel. |
| **Run Doctor** | Runs **APM: Run Doctor** in the same scope. |
| **Sign in to GitHub**, **Manage Repository Accounts**, **Authentication Help** | Fix repository access. See [Private repositories](private-repositories.md). **Authentication Help** opens the [APM authentication guide](https://microsoft.github.io/apm/getting-started/authentication/). |
| **Explain Policy** | Explains the package's effective executable policy. |
| **Show Targets** | Lists the deployment targets APM resolves. See [Deployment targets](projects.md#deployment-targets). |
| **Retry** | Repeats the original operation in its original scope. Changes ask for confirmation again. |

## Output and diagnostics

- **APM output channel:** open **View** > **Output** and select **APM**, or choose **Show Output** in a notification. It logs every APM command the extension runs, with tokens masked.
- **APM: Run Doctor:** runs `apm doctor` and opens the health check in a read-only document. It can make a network probe but never installs or repairs anything.

When reporting an issue, remove private repository names, tokens, and other private data from logs and screenshots.

## The APM CLI is not found

The view shows **APM CLI is not available** when the configured executable cannot run.

1. Choose **Show Output** to see what the extension tried.
2. Install the CLI with **Install APM CLI** or **APM: Install or Upgrade CLI**, or set `apm.executablePath` to the executable's full path. See [Set up the APM CLI](getting-started.md#set-up-the-apm-cli).
3. If you installed APM outside VS Code, choose **Refresh** in the view.

For Remote Development, install APM on the remote host, not on your local machine.

## APM version compatibility

The extension targets APM 0.35.0. Older versions get compatibility checks, and unsupported commands or options are reported instead of failing silently. A newer version is not assumed to be compatible just because its version number is higher.

When the extension recommends an upgrade, a notification offers **Update APM**, and the Activity Bar badge counts it. You can also run **APM: Install or Upgrade CLI**.

Package lists support the CLI's Unicode and ASCII tables. Malformed rows and truncated package identities are reported rather than guessed.

## No marketplace.json found

A private repository can return this misleading error when access is missing.

1. Sign in or add a token for the repository. See [Private repositories](private-repositories.md).
2. Grant organization SSO access if required, then retry.
3. If the error persists, check that the repository contains one of APM's supported marketplace manifests.

A `#ref` pinning warning is a separate issue from authentication.

## Rate limits

Anonymous GitHub requests are rate-limited. The extension retries with accounts you have already authorized when they can access the repository. If none can, connect an account with **APM: Sign in to GitHub** or wait until the reset time shown in the notification. Automatic refreshes reuse remote results for five minutes to reduce requests. See [Rate limits](private-repositories.md#rate-limits).

## Duplicate APM views or commands

If you see two APM views or duplicate commands, uninstall the development VSIX with the identifier `apm-local.apm-package-manager` and keep the Marketplace version.

## The view shows no packages

- **Untrusted workspace:** choose **Manage Workspace Trust**. See [Workspace Trust](security-and-trust.md#workspace-trust).
- **Empty catalog:** add a marketplace. See [Marketplaces](marketplaces.md).
- **Filters:** check the search box for `@` tokens and choose **Clear**.
- **Hidden sections:** open the view's **...** menu, then **Views**, and make sure **Catalog**, **Installed**, and **Updates** are checked.

## Unsupported environments

Browser-only VS Code (such as vscode.dev) and virtual workspaces are not supported, because they cannot run the APM CLI.
