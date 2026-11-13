# Security and trust

APM packages can deploy agent instructions, run scripts, and configure tools. The extension adds checks so that nothing changes without your approval. This page summarizes those checks and the commands for reviewing and changing executable trust.

## Workspace Trust

The extension requires [Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust). In an untrusted workspace:

- The view shows **Manage Workspace Trust** instead of package lists.
- APM does not run, package sources are not read, and settings are not synchronized.
- Project, dependency, trust, MCP, and lifecycle commands are hidden from the Command Palette and menus.

## What runs automatically

| Activity | Runs APM | Uses the network |
| --- | --- | --- |
| Refreshing the view | Read-only commands | Marketplace and update checks, reused for five minutes |
| Manifest completion, hover, and links | No | No |
| Task discovery | No | No |
| Settings synchronization | `apm config` and `apm marketplace` commands | Adding a marketplace can fetch it |
| Compile, validate, audit, reports, and package actions | Only after an explicit action | Depends on the action; network reports are labeled |

**APM: Run Doctor** can make a network probe. It does not install or repair anything.

## Confirmations

Every operation that can change files or run code asks for confirmation in a non-modal notification. Dismissing the notification makes no changes. Confirmations name the scope and execution host. They cover:

- Installing, updating, and uninstalling packages, including applying a previewed operation.
- Installing an MCP server.
- Initializing and compiling a project.
- Running a manifest script or lifecycle event, changing lifecycle trust, and adding or replacing a lifecycle block.
- Approving or denying executable primitives.
- Saving an SBOM.
- Installing or upgrading the APM CLI.

**Retry** in an error notification repeats the original operation in its original scope, and asks for confirmation again.

## Executable trust and policy

APM policy decides whether a package's executable primitives may run. The extension provides three commands, available from the Command Palette and **More APM Actions**.

| Command | What it does |
| --- | --- |
| **APM: Review Executable Trust** | Choose a project, then open a read-only report: **Policy status** (discovery source, cache, and effective rules), **Pending executable approvals**, or **Effective trust decisions**. |
| **APM: Explain Package Policy** | Pick an installed package in the current scope and open its effective policy decision. Error notifications about policy also offer **Explain Policy**. |
| **APM: Manage Executable Trust** | Approve or deny a package's executable primitives. |

**APM: Manage Executable Trust** asks for:

1. The package scope: a workspace folder or **Global (user)**.
2. An installed package in that scope.
3. **Approve executable primitives** or **Deny executable primitives**. A deny takes precedence.
4. Where to store the decision: **Shared project policy** (`apm.yml`, offered for initialized workspaces) or **Personal policy** (`~/.apm/config.json`). The package scope does not change.
5. Confirmation with **Apply Trust Decision**.

## Audits

APM audits scan deployed agent content for security findings. Run them on a single package from its page, or on the whole workspace to publish findings in **Problems**. See [Audit a package](managing-packages.md#audit-a-package) and [Audit the workspace](projects.md#audit-the-workspace). Incomplete scan coverage is always reported, never shown as a clean result.

## Remote images

Package READMEs can reference images on third-party hosts. To avoid contacting those hosts when a package page opens, remote images are blocked by default.

To allow HTTPS images, enable `apm.allowRemoteImages` in Settings on the host where APM runs. Image hosts can then see your network address and that you opened the documentation. Insecure HTTP and protocol-relative images stay blocked.

## Credentials and privacy

- Tokens are stored only in VS Code SecretStorage, never in settings, marketplace URLs, or project files. See [Private repositories](private-repositories.md).
- Tokens injected into APM are masked in the **APM** output channel and result documents.
- Values you enter for package MCP servers are hidden as you type, and verbatim echoes are redacted from captured output.
- The extension refuses URLs that contain credentials in package sources, marketplace sources, and the MCP registry setting.
- Package pages render README content through a sanitizer with a strict content security policy.
