# Settings synchronization instructions

Follow the [root guidance](../../AGENTS.md) for shared commands and safety rules.

- Keep [`cliConfig.ts`](cliConfig.ts) mappings, defaults, and the settings contributed by [`package.json`](../../package.json) consistent. On first sync an explicit VS Code value wins; otherwise import the CLI value.
- Run synchronization only for trusted workspaces and serialize mutations through the existing queue. Read CLI state and perform changes through APM rather than editing its registry or configuration files directly.
- Preserve collision checks and the previous marketplace registration when an addition or replacement fails; do not remove pending registrations after a failed addition.
- Preserve marketplace source normalization and the transport, alias, and ref collision checks. Relative paths require one local workspace folder and are persisted as absolute file URIs; reject embedded credentials.
- Reject HTTP URL userinfo and password-bearing URLs before registration or import, including existing CLI marketplace registrations and the MCP registry setting; retain SSH usernames.
- Cover synchronization behavior in [`test/config/marketplaces.test.ts`](../../test/config/marketplaces.test.ts) and, for host interactions, [`test/extension/suite.ts`](../../test/extension/suite.ts).

Run `npx tsx --test test/config/marketplaces.test.ts` from the repository root. Build before running the extension-host tests.
