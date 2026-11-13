# Private repositories

Packages and marketplaces can live in private repositories on GitHub.com, GitHub Enterprise, GitLab, Azure DevOps, or other approved hosts. The extension needs repository access to show their contents and README, and APM needs it to install them.

## Connect an account or token

| Where | What to do |
| --- | --- |
| Command Palette | Run **APM: Sign in to GitHub** to authorize a GitHub account through VS Code Accounts. |
| Command Palette | Run **APM: Manage Repository Accounts** to connect an account or token to a specific repository. |
| Error notifications | When an operation fails because of authentication, choose **Sign in to GitHub**, **Manage Repository Accounts**, or **Authentication Help**. |

Sign-in is requested only after an explicit action. Background refresh never prompts for sign-in or consent.

**APM: Manage Repository Accounts** offers four actions:

| Action | What it does |
| --- | --- |
| **Connect GitHub account** | Binds a GitHub account from VS Code Accounts to a repository after verifying its access. |
| **Add repository token** | Stores a repository-scoped personal access token after verifying its access. |
| **Approve repository host** | Approves the HTTPS origin of a GitHub Enterprise, GitLab, or Azure DevOps host and chooses its provider type. |
| **Remove repository authentication** | Disconnects a repository and deletes its owned token. |

When connecting an account or token, choose a repository from the list or **Enter another repository...**. The list includes configured marketplaces, known repositories, and the remote dependencies in the selected scope; local lockfile entries are not included. It is built locally, without checking access, until you choose a credential.

Direct GitHub package paths use the credentials of their parent repository. A marketplace can reference plugins in other repositories that need a different account.

## GitHub accounts

The extension uses VS Code Accounts for GitHub. For each repository, it silently tests accounts you have already authorized, starting with the remembered selection, and looks up other accounts only when access is denied.

To use GitHub Enterprise accounts from VS Code Accounts, set `github-enterprise.uri` to the host's origin. Otherwise, use a repository token. GitHub.com account tokens are never sent to another host.

## Personal access tokens

Enter tokens only through the masked input in **APM: Manage Repository Accounts**. Tokens are scoped to one repository and stored in VS Code SecretStorage, never in settings, marketplace URLs, or project files.

| Host | Required access |
| --- | --- |
| GitHub | Repository read access |
| GitLab | `read_api` and `read_repository` |
| Azure DevOps | Code (Read) |

Grant organization SSO access where your organization requires it.

## Enterprise and self-managed hosts

Approve a host before adding credentials for it: choose **Approve repository host**, enter its HTTPS origin without a path, and choose its provider (`github`, `gitlab`, or `azure`). Existing SSH aliases are not treated as HTTPS API hosts.

Other Git hosts keep working through the CLI and SSH, but the extension cannot browse their remote contents.

## Rate limits

- Known private repositories use their selected credentials directly instead of retrying anonymously for every metadata file.
- When anonymous requests are rate-limited, the extension silently checks your existing accounts for access before using them. If none can be verified, connect an account or wait until the reset time shown in the notification.
- Read-only access checks are reused for five minutes and cleared when accounts or tokens change. Repositories that refuse anonymous access skip repeated anonymous checks for five minutes.
- Before running APM, credential selection always checks access freshly. Within one refresh, each repository is checked once. Installs, updates, and other changes always check freshly.

## Switch or remove credentials

Run **APM: Manage Repository Accounts** again to change a repository's account or token, or choose **Remove repository authentication**. Removing does not sign the account out of VS Code Accounts or revoke the token at its provider.

Account changes clear cached authentication and reload open package pages. Running processes keep their existing environment.

## WSL and other remote hosts

Account bindings are kept per extension host. SecretStorage is managed by VS Code; do not assume it is a separate WSL-only credential vault. The APM executable and existing Git and SSH authentication belong to the remote host.

## CLI authentication compatibility

Separate marketplace registrations and refreshes can use different credentials, even for two repositories in the same organization. Remote contents, descriptions, and READMEs use the actual plugin repository's credentials.

APM 0.35.0 has no enforceable per-repository credential hook across its whole resolver. The extension therefore blocks operations that need conflicting credentials before starting the CLI, rather than retrying an install or update with another account after files may have changed.

- One GitHub account can cover multiple declared repositories.
- Resolver operations with saved bindings outside their known repository context, mixed origins, or unsupported credential types are blocked conservatively.
- Mixed-account installs, updates, and transitive dependency resolution need upstream APM support. A newer APM version number alone does not remove this limitation.

Sources without managed credentials keep APM's existing environment and CLI authentication. Local workflows such as compilation and task discovery do not need repository tokens. Project script tasks keep their existing environment and Git or SSH authentication; they do not receive the extension's repository credentials.

## Credentials in URLs

Do not put credentials in HTTP(S) URLs or passwords in other URLs. Use VS Code Accounts, **APM: Manage Repository Accounts**, or APM's own authentication. The extension rejects such URLs and does not copy an existing APM marketplace registration that contains credentials into its settings; remove or replace that registration in APM first.

For a misleading **No marketplace.json found** error on a private repository, see [Troubleshooting](troubleshooting.md#no-marketplacejson-found).
