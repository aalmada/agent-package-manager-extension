---
name: codebase-memory-lens
description: "Explore a codebase visually with codebase-memory-mcp Lens. USE FOR: starting or using CBM Lens; browsing source alongside graph relationships; viewing architecture, routes, hotspots, and index coverage; editing architecture decision records through the local UI. DO NOT USE FOR: agent-driven structural code discovery when the CLI is available; use the codebase-memory skill."
---

# codebase-memory-mcp Lens

Use Lens when a human wants to explore the indexed codebase visually. Lens is a browser UI bundled with codebase-memory-mcp v0.12.0 and later; it runs locally and listens on loopback.

## Quick start

1. Check that `codebase-memory-mcp --version` reports v0.12.0 or later; prefer the current stable release.
2. Start the UI:

   ```bash
   codebase-memory-mcp daemon start --open --port=9749
   ```

3. Open the local URL reported by the command.
4. Select an indexed project. Use Architecture for an overview or Explore to browse a file and its graph context.

Lens supports source and graph exploration, architecture and route views, hotspots, index coverage, ADR editing, and an optional browser-local assistant. The assistant may download a model when enabled; indexing, graph browsing, and CLI/MCP queries do not require a model or API key. Standard release binaries include Lens; some source and Nix builds omit it.

## Safety and scope

- Keep Lens on its loopback listener; do not expose it to an untrusted network.
- Lens complements, but does not replace, CLI graph queries for agent workflows. Use the [codebase-memory skill](../../../apm_modules/netfabric/intelligentium/plugins/codebase-memory/.apm/skills/codebase-memory/SKILL.md) for indexing readiness, structural discovery, and evidence checks.
- v0.12.1 adds Helm chart paths and changes image identities. The first index after upgrading is a full rebuild; wait for it to finish before relying on graph results.
