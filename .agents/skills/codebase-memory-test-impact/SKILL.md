---
name: codebase-memory-test-impact
description: "Use codebase-memory-mcp to estimate which tests a code change can affect. USE FOR: graph-based test selection; test-impact analysis from a diff; deciding whether CBM evidence supports a targeted test run. DO NOT USE FOR: replacing test execution or claiming full coverage from a partial graph."
---

# codebase-memory-mcp Test Impact

Use `detect_changes` to estimate which tests a code change can affect and why. This is a selection aid, not a substitute for test execution.

## Workflow

1. Verify `codebase-memory-mcp --version` and confirm the project index is ready and current with `codebase-memory-mcp cli index_status --project <name>`. Follow the [codebase-memory skill](../../../apm_modules/netfabric/intelligentium/plugins/codebase-memory/.apm/skills/codebase-memory/SKILL.md) if installation or indexing is needed.
2. Check the installed command's exact arguments:

   ```bash
   codebase-memory-mcp cli detect_changes --help
   ```

3. Run `detect_changes` for the intended diff and inspect its affected symbols, test scope, evidence, and limitations. Use the installed tool's flags for the selected release; do not assume test-selection support based only on language parsing.
4. Run selected tests only when CBM provides supported, sufficient evidence for this repository's test conventions.
5. Run the full relevant suite if the index is stale or incomplete, evidence is doubtful, no tests are identified unexpectedly, or the result explicitly calls for all tests. Do not silently narrow the selection.
6. Report CBM's selection separately from tests actually executed and their results.

CBM v0.12.0 introduced graph-based test impact. When evidence is incomplete or doubtful, the documented behavior is to broaden selection or recommend running all tests rather than silently omit potentially affected tests. Verify the installed release's exact behavior with `codebase-memory-mcp cli detect_changes --help` and the returned evidence.
