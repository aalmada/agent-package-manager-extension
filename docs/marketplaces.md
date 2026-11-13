# Marketplaces

Marketplaces are package catalogs registered with APM. The **Catalog** section of the [package browser](package-browser.md) lists the packages from every registered marketplace.

## Add or remove a marketplace

The list of marketplaces lives in the `apm.marketplaces` setting. Open it from any of these places:

| Where | What to do |
| --- | --- |
| APM view | Choose **Add marketplace** when no marketplaces are registered, or open the **...** menu and choose **Settings**. |
| Command Palette | Run **APM: Open Marketplace Settings**. |
| Settings editor | Search for `apm.marketplaces`. |

Add or remove items in the list. Adding an item runs `apm marketplace add`, and removing one runs `apm marketplace remove`. Marketplaces registered or removed with the APM CLI appear in the setting automatically. Synchronization runs only in a trusted workspace.

The setting is machine-scoped, so it lives in your user settings or, for Remote Development, in the remote host's settings. It cannot be set per workspace.

### Source formats

| Format | Example |
| --- | --- |
| GitHub shorthand | `owner/repo` |
| Shorthand on another host | `host/owner/repo` |
| Git HTTPS or SSH URL | `https://github.com/owner/repo.git`, `git@github.com:owner/repo.git` |
| `marketplace.json` URL | `https://example.com/marketplace.json` |
| Local path or `file:///` URI | `/path/to/marketplace`, `file:///path/to/repo` |

- Append `#ref` to a Git source, including a `file:///` URI, to pin a tag, branch, or commit.
- Prefix an entry with `name=` to choose its alias, for example `team=owner/repo`. Otherwise the alias is derived from the source so that it does not replace another registration. The package browser shows this registered alias everywhere, as described in [badges](package-browser.md#badges).
- Relative paths require a single local workspace folder and are converted to absolute file URIs.
- Do not put credentials in URLs; SSH usernames are allowed. Use [private repository authentication](private-repositories.md) instead. The extension does not copy an existing APM registration that contains URL credentials into the setting; remove or replace it in APM first.

For Remote Development, Git credentials and local marketplace paths must be available on the remote host.

## Browse one marketplace

To show packages from a single marketplace, open the filter (funnel) menu and choose **Marketplace** > **Choose Marketplace...**, or type `@marketplace:<name>` in the search box. Choose **All Marketplaces** to clear the filter. To group the catalog by marketplace, choose **Sort By** > **Marketplace**.

## Check marketplace health

**APM: Check Marketplace Health** runs read-only marketplace reports. Run it from the Command Palette or from **More APM Actions** in the view's **...** menu. It requires a trusted workspace with an open folder.

| Report | What it does |
| --- | --- |
| **Check marketplace entries (network)** | Resolves the entries in the project's marketplace configuration. |
| **Check marketplace entries (offline)** | Validates schema and cached refs without network access. |
| **Show outdated marketplace packages (network)** | Looks for available upgrades. |
| **Show outdated packages (offline)** | Uses cached refs only. |
| **Validate a registered marketplace** | Checks the structure and plugin schema of a marketplace you pick. |
| **Audit marketplace dependencies (may fetch refs)** | Checks whether plugin dependencies resolve through a marketplace you pick. |

Network and offline variants are labeled separately. Reports open in read-only documents. A report that exits with a nonzero code still opens, together with a warning notification, so you can review the findings.

## Private marketplaces

A marketplace in a private repository needs repository access. See [Private repositories](private-repositories.md). A misleading **No marketplace.json found** error usually means access is missing; see [Troubleshooting](troubleshooting.md#no-marketplacejson-found).
