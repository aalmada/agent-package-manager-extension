# CBM v0.12.1 Tools and Graph Model

Source: [v0.12.1 MCP tool registry](https://github.com/DeusData/codebase-memory-mcp/blob/v0.12.1/src/mcp/mcp.c), [tagged README](https://github.com/DeusData/codebase-memory-mcp/blob/v0.12.1/README.md), and [release notes](https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.12.1). The registry exposes 17 tools. The tagged `docs/llms.txt` says 15; use the registry for the current tool names.

## CLI and MCP

Call tools as one-shot CLI commands or through an existing MCP connection. Prefer the CLI in authored agent workflows; inspect the installed schema for exact flags:

```bash
codebase-memory-mcp cli <tool_name> --help
codebase-memory-mcp cli search_graph --project my-project --name-pattern '.*Handler.*' --label Function
codebase-memory-mcp cli trace_path --project my-project --function-name Search --direction both
codebase-memory-mcp cli query_graph --project my-project --query 'MATCH (f:Function) RETURN f.name LIMIT 5'
```

The CLI accepts `--json` when the full MCP result envelope is needed. Use CLI `--help` instead of guessing flags when the schema or invocation is unclear.

## All 17 tools

| Tool | Purpose |
| --- | --- |
| `index_repository` | Index or reindex a repository; supports `full`, `moderate`, `fast`, and `cross-repo-intelligence` modes. |
| `index_status` | Check a project's indexing state, freshness, and watcher status. |
| `list_projects` | List indexed projects; paginate large results. |
| `delete_project` | Delete a project's index and graph data. Treat as destructive; do not call without explicit authorization. |
| `search_graph` | Find graph nodes by text, regular-expression/name, qualified-name, file, label, relationship, or semantic query; results are paginated. |
| `search_code` | Search text within indexed project files. |
| `trace_path` | Trace calls, data flow, cross-service relationships, infrastructure topology, deployment paths, or what a service runs. Call depth is bounded; defaults omit tests. |
| `query_graph` | Run read-only Cypher-subset queries, including graph traversals and aggregation. Results are bounded and may require continuation. |
| `get_graph_schema` | Inspect graph labels, edge types, counts, and optionally queryable properties. |
| `get_architecture` | Get a bounded static architecture summary; it is not a full data-flow analysis or runtime trace. |
| `get_code_snippet` | Read a symbol's source by qualified name; discover the exact name first. Large source responses may be paged or outlined. |
| `get_file_outline` | List declarations in an exact repository-relative file path, optionally filtered by node label and paginated. |
| `compare_graphs` | Compare two indexed project snapshots for target-only additions and base-only removals; review result limits and truncation metadata. |
| `check_index_coverage` | Check whether requested paths were parsed/indexed and inspect recorded gaps before relying on absence claims. |
| `detect_changes` | Analyze changes against the graph, including affected symbols and supported test-impact analysis. |
| `manage_adr` | Read or change architecture decision records stored with the graph. Writes change persistent state. |
| `ingest_traces` | Store externally observed runtime call paths; this writes graph state and does not collect traces itself. |

`index_repository`, `delete_project`, `manage_adr`, and `ingest_traces` change persistent state. Restrict writes to the requested task; never treat `delete_project` as routine cleanup.

## Graph features

### Code and semantic search

The v0.12.1 release parses 158 languages with vendored grammars. Hybrid LSP-style type resolution is available for a smaller set of language families; parser support does not imply equal relationship-resolution depth. `search_graph` can use local bundled embeddings for semantic search; no model, hosted service, or API key is required.

Common code labels include `Project`, `Package`, `Folder`, `File`, `Module`, `Class`, `Function`, `Method`, `Interface`, `Enum`, `Type`, and `Route`. Documentation and infrastructure add entities such as ADRs, diagrams, images, charts, and resources. Use `get_graph_schema` for the labels, relationships, and properties actually present in a project.

Graph relationships include containment, definitions, imports, calls, references, inheritance, implementation, type use, data flow, HTTP and asynchronous calls, pub/sub (`EMITS`/`LISTENS_ON`), documentation mentions (`MENTIONS`), deployment (`DEPLOYS`), cross-repository links, near-clone (`SIMILAR_TO`), and vocabulary-mismatch (`SEMANTICALLY_RELATED`) relationships. This is representative, not a guarantee of extraction for every language or file format. Inspect schema and coverage before relying on an edge or its absence.

### Documentation and API descriptions

v0.12.0 added supported doc-comment and document references, Markdown, reStructuredText/Sphinx, AsciiDoc/Antora, PDF text pages, ADRs, Mermaid, PlantUML, Graphviz, D2, draw.io and Excalidraw diagrams, and OpenAPI/Swagger operations. Documentation and code are linked only when a reference resolves according to the indexer's rules; unresolved or ambiguous references are not proof that no relationship exists. PDF extraction is text-based, not OCR.

### Infrastructure and deployment

Supported inputs include Docker/Compose, Kubernetes, Helm, Kustomize, and deployment-related configuration such as supported CI files and scripts. v0.12.1 links Helm charts to rendered Kubernetes objects and literal image references, and values files to charts. Image names without a declared registry remain as written with `registry: unknown`. These are statically inferred relationships, not confirmation of a live deployment.

### Cypher subset

`query_graph` is read-only. Supported constructs include `MATCH`/`OPTIONAL MATCH`, `WHERE`, `WITH`, `RETURN`, ordering and pagination, `UNWIND`, `UNION`, `CASE`, variable-length paths, `EXISTS`, aggregates, and selected functions. It is not full openCypher: write clauses, `CALL`, parameters, list/map literals, and comprehensions are unsupported. Use `get_graph_schema` to inspect queryable properties and `--help` for current query and continuation options.

For example, find functions without incoming `CALLS` edges:

```cypher
MATCH (f:Function)
WHERE NOT EXISTS { (f)<-[:CALLS]-() }
RETURN f.name, f.file_path
LIMIT 50
```

Zero callers is only a candidate, not proof of dead code. Check entry points, index coverage, pagination, and unresolved relationships; read flagged source ranges before making an absence claim.
