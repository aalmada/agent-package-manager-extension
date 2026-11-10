---
name: codebase-memory
description: "Install, update, and integrate codebase-memory-mcp (CBM), a local knowledge-graph server for codebases. USE FOR: checking CBM installation and index readiness; installing or updating the binary; configuring its CLI/MCP workflows in agents, skills, prompts, and subagents. DO NOT USE FOR: exploring code with graph queries; use codebase-memory-exploration. For the visual UI use codebase-memory-lens; for affected-test selection use codebase-memory-test-impact."
---

# codebase-memory-mcp (CBM)

CBM indexes code, documentation, and supported infrastructure into a local graph. Queries and bundled semantic search run locally and need no hosted service, model, or API key. The optional Lens browser chat is separate.

## Quick reference

| Need | Command or guide |
| --- | --- |
| Check installation | `command -v codebase-memory-mcp && codebase-memory-mcp --version` |
| Install on macOS/Linux | `curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh \| bash` |
| Check project readiness | `codebase-memory-mcp cli index_status --project <name>` |
| Install, update, configuration, and index recovery | [Installation guide](references/installation.md) |
| Wire CBM into an agent or squad | [Integration guide](references/integration-guide.md) |
| Learn all tools and graph features | [v0.12.1 tool reference](references/tools.md) |

Use [codebase-memory-exploration](../../../apm_modules/netfabric/intelligentium/plugins/codebase-memory/.apm/skills/codebase-memory-exploration/SKILL.md) for graph-driven codebase work, [codebase-memory-lens](../../../apm_modules/netfabric/intelligentium/plugins/codebase-memory/.apm/skills/codebase-memory-lens/SKILL.md) for the local browser UI, and [codebase-memory-test-impact](../../../apm_modules/netfabric/intelligentium/plugins/codebase-memory/.apm/skills/codebase-memory-test-impact/SKILL.md) for change-based test analysis.
