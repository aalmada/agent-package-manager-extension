---
name: codebase-memory-exploration
description: "Explore a codebase with codebase-memory-mcp's knowledge graph. USE FOR: understanding unfamiliar code; finding symbols, callers, dependencies, and architecture; following documentation, service, or deployment relationships; comparing indexed snapshots; checking graph evidence and coverage. DO NOT USE FOR: installing or configuring CBM; use the codebase-memory skill. For human visual exploration, use codebase-memory-lens."
---

# Explore a Codebase with CBM

Use the CBM CLI for structural questions. Treat graph results as evidence bounded by the current index, indexed files, query scope, and returned pages; use source reads to resolve gaps.

## Check readiness

1. Verify the installed binary and project index:

   ```bash
   command -v codebase-memory-mcp
   codebase-memory-mcp --version
   codebase-memory-mcp cli index_status --project <project>
   ```

2. If the project is missing, stale, or not ready, index it and check status again:

   ```bash
   codebase-memory-mcp cli index_repository --repo-path "$PWD" --name <project>
   codebase-memory-mcp cli index_status --project <project>
   ```

3. Continue only when the index is ready and current. Follow the [installation guide](../../../apm_modules/netfabric/intelligentium/plugins/codebase-memory/.apm/skills/codebase-memory/references/installation.md) if CBM is missing.

## Find and understand code

1. Orient with `get_architecture` or `get_graph_schema`.
2. Find candidates with `search_graph` (name, qualified name, label, file, text, or semantic query) or `search_code`.
3. Use `get_file_outline` with an exact repository-relative path to inspect declarations in a file.
4. Use `get_code_snippet` with the exact qualified name to read a symbol.
5. Use `trace_path` for callers/callees or other supported relationships. Discover exact names first; inspect `--help` for modes and flags.
6. Use `query_graph` when filtered multi-hop traversals or aggregation need Cypher.

```bash
codebase-memory-mcp cli get_graph_schema --project <project>
codebase-memory-mcp cli get_architecture --project <project>
codebase-memory-mcp cli search_graph --project <project> --name-pattern '.*Handler.*' --label Function
codebase-memory-mcp cli trace_path --project <project> --function-name <exact-name> --direction both
```

## Verify evidence

- Check `has_more`, totals, and continuation fields; retrieve all relevant pages before making exhaustive claims.
- Call `check_index_coverage` for every path used as evidence. A clean coverage result means no recorded gap, not proof the index is complete.
- Read source ranges directly when coverage is partial, skipped, excluded, pending, stale, or unknown. Do the same for unresolved documentation references or relationships.
- Treat zero callers from `trace_path`, `search_graph`, or Cypher as a dead-code candidate, not a conclusion. Account for entry points and relationship types beyond `CALLS`.
- Treat infrastructure and route relationships as static index evidence, not proof of live runtime behavior.
- `query_graph` is read-only and supports a Cypher subset, not full openCypher. Check tool help and the [tool reference](../../../apm_modules/netfabric/intelligentium/plugins/codebase-memory/.apm/skills/codebase-memory/references/tools.md).

## Change impact and related graph workflows

- Use `detect_changes` to map local changes to affected symbols and risk. Its test-impact mode is an estimate; follow the [test-impact skill](../../../apm_modules/netfabric/intelligentium/plugins/codebase-memory/.apm/skills/codebase-memory-test-impact/SKILL.md), and do not narrow test execution when evidence is incomplete.
- Use `compare_graphs` to compare two indexed snapshots; inspect totals and truncation metadata.
- For cross-repository relationships, ensure all intended projects are indexed in the same store and use the explicit `cross-repo-intelligence` indexing mode when needed. This mode changes graph data; run it only when requested.
- Use `trace_path` modes for supported data-flow, cross-service, topology, deployment, or service-to-program paths. These are static relationships.
- Use `manage_adr` or `ingest_traces` only when explicitly asked to write graph state. `ingest_traces` records externally collected call paths; it does not collect traces.

See the [tool reference](../../../apm_modules/netfabric/intelligentium/plugins/codebase-memory/.apm/skills/codebase-memory/references/tools.md) for all 17 tools and supported graph areas.
