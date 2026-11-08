# Testing, CI, and Publishing

## Test at the right boundary

| Test type | Cover |
| --- | --- |
| Unit | Pure logic, parsing, adapters, validation, and error handling without a VS Code instance. |
| Extension Host | Contributions and VS Code API integration, trust, commands, configuration, providers, tasks, and disposal. |
| Browser | Webview behavior, accessibility, theme modes, responsive layouts, and message handling. |
| Package smoke test | Successful VSIX creation, required files, manifest metadata, and production assets. |

Use temporary workspaces and isolated user data. Mock external executables, network services, and authentication except in explicitly opt-in integration tests. Cover cancellation, malformed input, missing workspaces, multi-root scope, startup failure, and both supported and unsupported trust modes.

### Example: Extension Host integration test

Use the VS Code test runner for API behavior that unit tests cannot exercise. Keep assertions focused on an observable contract and isolate workspace state.

```ts
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { suite, suiteSetup, test } from 'mocha';

suite('Report command', () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('publisher.extension-name');
    assert.ok(extension, 'Extension must be installed in the test host');
    await extension.activate();
  });

  test('opens the report command result', async () => {
    await vscode.commands.executeCommand('sample.openReport');

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    assert.match(editor.document.getText(), /Report/);
  });
});
```

This Mocha-style test runs inside the Extension Development Host. Use the runner and framework already configured by the extension, and clean up test documents or temporary workspaces.

## CI

- Install from the lockfile and use supported Node.js and VS Code versions.
- Run type-checking, lint, unit tests, production build, Extension Host tests, browser tests, and package creation as applicable.
- Use an OS matrix for platform-sensitive code and extension-host behavior. Install required display or browser dependencies explicitly.
- Separate tests requiring a real CLI, network, or credentials from the default deterministic suite; pin versions and verify downloaded artifacts.
- Upload the exact VSIX produced by validation. Pin third-party GitHub Actions to full commit SHAs and grant only required permissions.

### Example: CI job shape

Replace script names, runtime versions, and matrix entries to match the extension. Resolve each action tag to its verified full commit SHA before using the workflow; do not copy mutable tags as a production pin.

```yaml
name: Validate extension
on: [push, pull_request]
permissions:
  contents: read
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@<verified-full-commit-sha>
      - uses: actions/setup-node@<verified-full-commit-sha>
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run compile
      - run: npx vsce package
```

Add lint, type-checking, browser tests, Extension Host tests, or platform setup when the project uses them. Upload the generated VSIX from this same validation job rather than rebuilding an unvalidated artifact during publishing.

## Package and publish

1. Verify `publisher`, `name`, `version`, `engines.vscode`, repository/license, icon, README, changelog, and included package files.
2. Run the prepublish/build command and create a VSIX with `vsce package`. Inspect package contents and test installation of the artifact.
3. Publish only a validated artifact. Prefer Marketplace Trusted Publishing/OIDC in supported CI; otherwise use a protected, narrowly scoped secret and never print it.
4. Gate release workflows on the intended branch/tag and required CI. Grant `id-token: write` only to the publishing job; serialize releases and make failures visible.
5. Follow the repository's versioning, changelog, approval, and rollback process. Do not hand-edit generated package artifacts.

For Marketplace Trusted Publishing, use the `vsce` OIDC option in the dedicated publish job after configuring the Marketplace publisher policy. Keep `id-token: write` scoped to that job and publish the exact VSIX downloaded from validation.

## Sources

- [Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [Continuous Integration](https://code.visualstudio.com/api/working-with-extensions/continuous-integration)
- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Marketplace Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)
