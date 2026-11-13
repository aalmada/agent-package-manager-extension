# Settings

The extension's settings control how it finds the APM CLI, which marketplaces it uses, and the supported subset of APM's own configuration. Many operations described in this guide can be configured here instead of through commands.

## Open the settings

| Where | What to do |
| --- | --- |
| APM view | Open the **...** menu and choose **Settings**. This opens the Settings editor filtered to the extension. |
| Command Palette | Run **APM: Open Marketplace Settings** to go straight to `apm.marketplaces`, or **Preferences: Open Settings (UI)** and search for `apm.`. |
| `settings.json` | Run **Preferences: Open User Settings (JSON)** and edit the keys below. |

## Settings reference

| Setting | Default | Description |
| --- | --- | --- |
| `apm.executablePath` | `"apm"` | Name or path of the APM executable on the workspace host (local, SSH, WSL, or container). See [Set up the APM CLI](getting-started.md#set-up-the-apm-cli). |
| `apm.marketplaces` | `["netfabric/intelligentium"]` | Marketplaces registered with APM. See [Marketplaces](marketplaces.md#add-or-remove-a-marketplace). |
| `apm.allowRemoteImages` | `false` | Allow package documentation to load HTTPS images from remote hosts. See [Remote images](security-and-trust.md#remote-images). |
| `apm.tasks.includeScripts` | `false` | Include named manifest scripts in APM tasks and enable **APM: Run Script**. See [Manifest scripts](projects.md#manifest-scripts). |
| `apm.config.autoIntegrate` | `true` | Discover `.prompt.md` files under `.github/prompts/` and `.apm/prompts/` and merge them into compiled `AGENTS.md` output. Mirrors APM's `auto-integrate`. |
| `apm.config.target` | `[]` | Default targets for `apm install` and `apm update` when neither `--target` nor `apm.yml` sets them. Empty uses auto-detection. Mirrors APM's `target`. |
| `apm.config.preferSsh` | `false` | Prefer SSH transport for `owner/repo` shorthand dependencies. Mirrors APM's `prefer-ssh`. |
| `apm.config.allowProtocolFallback` | `false` | Retry a failed clone with the opposite protocol (SSH or HTTPS). Mirrors APM's `allow-protocol-fallback`. |
| `apm.config.mcpRegistryUrl` | `""` | Private MCP registry endpoint for `apm mcp` and `apm install --mcp`. Empty uses the public registry; `MCP_REGISTRY_URL` overrides it. Mirrors APM's `mcp-registry-url`. See [MCP servers](mcp-servers.md#use-a-private-registry). |
| `apm.config.tempDir` | `""` | Existing directory for clone and download operations. Empty uses the system temporary directory; `APM_TEMP_DIR` overrides it. Mirrors APM's `temp-dir`. |

`apm.tasks.includeScripts` can be set per workspace or folder. `apm.executablePath` is a machine setting that a workspace can override. The other settings are machine settings: set them in your user settings or, for Remote Development, in the remote host's settings.

## Synchronization with APM

The `apm.marketplaces` and `apm.config.*` settings mirror APM's own state, so changes made in VS Code or with the CLI stay in step:

- **Marketplaces:** adding an item runs `apm marketplace add`, and removing one runs `apm marketplace remove`. Marketplaces registered or removed with the CLI appear in the setting.
- **CLI configuration:** changing a setting runs `apm config set` (or `apm config unset` when cleared). Changes to APM's `config.json` are imported into the settings.
- **First synchronization:** a value you set explicitly in VS Code wins; otherwise the CLI's value is imported.

Synchronization runs only in a trusted workspace. If APM cannot apply a value, an error notification explains why. Imported values that equal the default are removed from `settings.json` rather than written explicitly.

Other APM configuration keys have no VS Code setting; configure them with the APM CLI.

## Preferences stored elsewhere

- **Repository credentials** live in VS Code SecretStorage, managed through **APM: Manage Repository Accounts**. See [Private repositories](private-repositories.md).
- **View layout**, including section sizes, collapsed sections, visible sections, and the current scope, is saved automatically.
- **Executable trust decisions** live in `apm.yml` or `~/.apm/config.json`. See [Executable trust and policy](security-and-trust.md#executable-trust-and-policy).
