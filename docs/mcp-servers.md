# MCP servers

APM can install [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) servers from an MCP registry. The extension lets you look up servers in the registry and install them by name.

## Discover MCP servers

Run **APM: Discover MCP Servers** from the Command Palette or **More APM Actions**, then choose a query:

| Query | Input | APM command |
| --- | --- | --- |
| **List MCP servers (registry/network)** | None | `apm mcp list` |
| **Search MCP servers (registry/network)** | A keyword or phrase | `apm mcp search` |
| **Show MCP server details (registry/network)** | The exact registry name | `apm mcp show` |

Every query contacts the registry and runs only when you ask. Results open in read-only documents. A query that exits with a nonzero code still opens its report, together with a warning notification.

## Install an MCP server

| Where | What to do |
| --- | --- |
| Command Palette | Run **APM: Install MCP Server**. |
| More APM Actions | Choose **Install MCP Server**. |

1. Choose a destination: an initialized workspace folder or **Global (user)**. The view's scope filter does not affect this choice.
2. Enter the exact registry name. Use **Show MCP server details** to confirm it first.
3. Confirm the installation.

The extension runs `apm install --mcp <name>`, then opens the result in a read-only document.

If an MCP server needs a value such as an API key, VS Code asks for it in a hidden input box. Values already set as environment variables are used without asking. See [MCP server values](managing-packages.md#mcp-server-values).

## Use a private registry

By default, APM uses the public MCP registry. To use another registry, set `apm.config.mcpRegistryUrl` in Settings; leave it empty for the public registry. The setting mirrors APM's `mcp-registry-url` configuration key, and the `MCP_REGISTRY_URL` environment variable overrides it.

Do not put credentials in the registry URL. The extension rejects URLs that contain them; use APM authentication instead.
