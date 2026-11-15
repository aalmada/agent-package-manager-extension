# Webview instructions

Follow the [root guidance](../../AGENTS.md) for shared commands and safety rules.

- This code runs in a browser webview, not the Node extension host. Communicate through the typed [`State` and `Message` protocol](../protocol.ts); update host-side message validation and handling when changing it.
- Render untrusted package data as text. Only insert README HTML after the host sanitizes it in [`src/views/markdown.ts`](../views/markdown.ts); retain the content security policy in [`src/views/html.ts`](../views/html.ts).
- Block remote README images by default; `apm.allowRemoteImages` is a machine-scoped VS Code setting that opts in to HTTPS images. Keep sanitization and the webview CSP in sync when it changes.
- Route external links through the host's validated `external` message rather than opening arbitrary URLs directly.
- Use VS Code theme variables and preserve keyboard access and narrow layouts. Browser tests cover dark, light, and high-contrast themes.
- Reuse `.badge` for package tags and `installationTag` for scope/status labels. Keep badge colors and borders in the shared CSS rule; retain keyboard-focus outlines and uniform forced-colors borders.
- The package browser window (`mode: 'gallery'`) reuses the sidebar search, filters, and `packageTags`; it shows no package icons. Its cards wrap full descriptions, while the sidebar keeps one line. Its details render in place (`gallery: true`) and return through the `back` message, restoring list focus and scroll.
- Keep gallery radio groups in the left rail in this order: Order by, Scope, Marketplace. Reuse `galleryFilterGroup` for consistent controls; reserve the funnel menu for the compact sidebar. Reuse shared filter tokens, keep controls synchronized with search, and disable ordering for dependency trees. Preserve scroll and keyboard focus when filters re-render.
- The gallery Dependencies page keeps List/Tree and the tree scope in saved state. The tree is an ARIA `tree` with roving tabindex and path-based item ids so re-rendering keeps focus; send `dependencyTree` with a `scopeKey` only from explicit Load/Reload actions.
- The build copies CSS once; watch mode does not recopy later CSS changes. Rebuild before browser tests.

Run `npx tsx --test test/webview/filter.test.ts test/webview/ui.test.ts` from the repository root. Use the browser test command in the root guidance for rendered layout changes.
