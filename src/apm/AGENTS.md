# APM integration instructions

Follow the [root guidance](../../AGENTS.md) for shared commands and safety rules.

## CLI and contract

- [The contract](contract.json) is generated from the pinned APM 0.35.0 source by [`scripts/sync-contract.py`](../../scripts/sync-contract.py). Regenerate it rather than editing it by hand; validate contract changes against the matching real CLI using the opt-in tests in [`test/apm/live.test.ts`](../../test/apm/live.test.ts).
- Keep command and flag availability probed for every non-baseline CLI, including newer versions. Preserve the compatibility warning and rejection of unsupported workflows.
- Build validated argument arrays with [`buildCommandArguments`](commands.ts); use shell-free execution for CLI processes and VS Code process tasks.
- Route commands with `requiresTerminal`: `compile --watch` uses a managed task outside the bounded mutation queue; initialization uses the terminal wizard unless `--yes`, discovery, or apply mode is explicit. Never inject `--yes` into an interactive initialization.
- Preserve task cancellation, exit codes, startup failures, and termination on extension disposal. Confirmed `runtime remove --yes` can use the visual runner; otherwise it needs a terminal.
- Preserve stdout, stderr, exit status, cancellation, and timeout information. Unrecognized or truncated CLI output must remain an explicit error, not an empty catalog or a current update state.
- Preserve audit coverage diagnostics and distinguish physical source positions from decoded-prompt offsets. Incomplete coverage must not be reported as a clean audit.
- Mask all prompted MCP variable values and redact verbatim echoes from captured and streamed process output, regardless of the variable name.
- Reuse package identities/update semantics for dry-run previews and apply. Keep previews nonmutating and label incomplete/offline plans.
- `execute` defaults to bounded capture; managed streaming tasks may explicitly disable timeout and capture. Preserve pending-line safety limits and cancellation.

## Metadata

- Treat CLI lockfiles and caches as read-only. Use the existing containment checks for marketplace paths and symlinks, and retain errors when metadata cannot be read safely.
- Preserve marketplace-qualified package identities and distinguish unknown, non-comparable, failed, and stale update results from confirmed current results.
- Match direct Git installations to catalog entries by resolved repository and subdirectory, not names. Use `sourceIdentity` for display matching and scoped details reuse; preserve CLI and lock identities for mutations.
- Set `catalogMarketplace` from the APM registry: the registered spelling of a recorded name, or the one catalog marketplace matching a direct installation or an unregistered recorded name. Keep a registered name whose catalog failed. Use `marketplaceLabel` for display, search, filtering, and sorting; never pass `catalogMarketplace` to APM or use it for update comparisons.
- Keep credential redaction on output and webview payloads; do not clone arbitrary repositories merely to display documentation.
- Only locally verified package roots may produce file navigation identities. Recheck realpath containment when opening links.

Run `npx tsx --test test/apm/commands.test.ts` for contract and argument changes, and select the corresponding files under [`test/apm/`](../../test/apm/) for adapter, process, or metadata changes.
