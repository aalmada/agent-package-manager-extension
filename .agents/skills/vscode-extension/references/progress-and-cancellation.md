# Progress and Cancellation

## Lifecycle

- Keep progress in the affected view when possible. Use notification progress for explicit, long-running operations requiring global visibility.
- Capture operation scope before awaiting inputs or starting work. Pass a cancellation token through every cancellable layer; the Cancel button alone does not stop work.
- Dispose cancellation listeners, abort network requests, and terminate owned child processes when cancelled. Do not terminate unrelated work.
- Await cleanup before resolving progress. Distinguish cancellation, failure, and completion; do not report partial mutations as successfully rolled back.

## Example: cancellable operation

Supply a worker that observes the token, stops safely, and returns `cancelled` only after cleanup. Let failures reject; the calling command must catch and report them. The helper uses global progress only because the operation was explicitly invoked.

```ts
import * as vscode from 'vscode';

type OperationResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'cancelled' };

async function withOperationProgress<T>(
  run: (
    token: vscode.CancellationToken,
    report: (message: string) => void
  ) => Promise<OperationResult<T>>
): Promise<OperationResult<T>> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Generate report',
    cancellable: true
  }, async (progress, token) => {
    progress.report({ message: 'Preparing' });
    if (token.isCancellationRequested) return { status: 'cancelled' };
    return run(token, message => progress.report({ message }));
  });
}
```

Do not infer cancellation solely from the token after the worker finishes: an operation may have committed before the cancellation request arrived. Trust the worker's explicit result.

## Example: bridge cancellation to a network request

```ts
import * as vscode from 'vscode';

async function fetchText(url: URL, token: vscode.CancellationToken): Promise<string> {
  const controller = new AbortController();
  const listener = token.onCancellationRequested(() => controller.abort());
  if (token.isCancellationRequested) controller.abort();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}.`);
    return await response.text();
  } finally {
    listener.dispose();
  }
}
```

Validate the destination before calling this helper. Add an appropriate request timeout. At the worker boundary, classify an abort caused by user cancellation separately from failures; do not broadly swallow fetch errors or treat timeouts as success.

## Sources

- [Progress API](https://code.visualstudio.com/api/extension-capabilities/common-capabilities#progress-api)
- [CancellationToken](https://code.visualstudio.com/api/references/vscode-api#CancellationToken)
