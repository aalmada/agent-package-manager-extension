# APM projects

An APM project is a workspace folder with an `apm.yml` manifest. This page covers creating a project, editing its manifest, and running project workflows such as compilation, validation, audits, tasks, and lifecycle scripts.

Project workflows require a trusted workspace with an open folder. When a workflow starts from a manifest, it uses that manifest's folder; otherwise it uses the current folder or asks you to choose a project. A running workflow keeps the folder it started with.

## Initialize a project

| Where | What to do |
| --- | --- |
| APM view | Choose **Initialize APM project**. It appears when the current folder has no manifest. |
| Command Palette | Run **APM: Initialize Project**. |
| Explorer | Right-click a folder and choose **APM: Initialize Project**. |

The extension asks for each value in a native input box:

1. **Project name** (required). It defaults to the folder name.
2. **Version**, **Description**, and **Author** (optional). Leave a value blank to use APM's default.
3. **Target harnesses**, in a multi-select picker. Leave it empty for APM auto-detection.

A confirmation notification then shows every value. Choose **Run** to create `apm.yml` in the selected folder. No terminal wizard opens, and no nested project is created. If the folder already has a manifest, the extension opens it instead of overwriting it.

## Edit the manifest

When `apm.yml` is open, the extension provides:

- Completion for manifest fields and targets.
- Hover documentation for fields.
- Links from dependency entries to their sources.
- **APM: Validate Manifest and Primitives** and **APM: Preview Compilation** buttons in the editor title bar.

These features work locally: completion and hover never run APM or make network requests. If the Red Hat YAML extension is active, its syntax diagnostics replace the extension's local ones, and no additional language server is required.

Manifests without a `$schema` use APM's working-draft format. The extension does not assign a published OpenAPM subset schema, change a project's contract, or claim complete schema validation. An explicit `$schema` stays authoritative; the CLI and the selected schema must agree.

Manifest-driven features such as LSP declarations, lifecycle definitions, and replacement rules stay managed by APM. Edit the manifest, then run the relevant workflow.

## Compile, preview, and validate

| Workflow | Command Palette | Editor title (`apm.yml`) | Explorer (`apm.yml`) | Task |
| --- | --- | --- | --- | --- |
| Compile | **APM: Compile** | | | `compile` |
| Preview compilation | **APM: Preview Compilation** | Yes | | |
| Validate | **APM: Validate Manifest and Primitives** | Yes | Yes | `validate` |
| Watch and recompile | | | | `watch` |

- **Compile** runs `apm compile` after a confirmation notification, because APM may write files. Preview first to inspect planned changes.
- **Preview compilation** runs `apm compile --dry-run` and opens the plan in read-only editors.
- **Validate** runs `apm compile --validate`. Success shows a notification with **Show Output**; failure shows an error with [recovery actions](troubleshooting.md#recovery-actions).

These commands run with cancellable progress and log to the **APM** output channel. Watch runs only as a [task](#tasks-and-scripts).

## Audit the workspace

| Where | What to do |
| --- | --- |
| Command Palette | Run **APM: Audit Workspace**. |
| Explorer | Right-click `apm.yml` and choose **APM: Audit Workspace**. |
| Tasks | Run the `audit` task, which uses `apm audit --ci`. |

The audit runs `apm audit --format json`, publishes findings to the **Problems** panel, and opens it. Findings in decoded structured prompts open a read-only decoded document instead of a misleading physical line. Incomplete coverage is reported as a warning, never as a clean scan. Editing an affected document clears its stale Problems entries.

To audit a single package, use **Audit** on its page; see [Audit a package](managing-packages.md#audit-a-package).

## Deployment targets

Targets decide which coding harnesses receive deployed files.

- **In the project:** set targets when you [initialize the project](#initialize-a-project), or edit `targets` in `apm.yml`.
- **As a default:** set `apm.config.target` in Settings. It applies to `apm install` and `apm update` when neither `--target` nor the manifest sets targets. Leave it empty for auto-detection.
- **Explain targets:** when an operation fails because of targets, the error notification offers **Show Targets**. It lists the targets APM resolves, with their status, source, and deployment folder, and selecting one opens the `targets` entry in `apm.yml`.

Package installs and previews never pass target overrides; they follow the manifest and APM's configuration.

## Tasks and scripts

**Tasks: Run Task** lists APM's `compile`, `watch`, `validate`, and `audit` workflows for each workspace manifest. Task discovery reads manifests only; it never runs APM or makes network requests. No task runs when a folder opens.

To save a task in `.vscode/tasks.json`, use the `apm` task type:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "APM: validate",
      "type": "apm",
      "workflow": "validate"
    }
  ]
}
```

Supported `workflow` values are `compile`, `watch`, `validate`, `audit`, and `script`. Built-in workflows stream through a managed task terminal that redacts output. Tasks check CLI capabilities when they run. Watch has no time limit and does not block package actions or settings synchronization.

### Manifest scripts

Named scripts in `apm.yml` run project-defined commands, so they are off by default.

1. Enable `apm.tasks.includeScripts` in Settings. APM's experimental script support must also be enabled.
2. Run **APM: Run Script** from the Command Palette and pick a script, or run its `script: <name>` task from **Tasks: Run Task**. Saved script tasks also set `"script": "<name>"`.
3. Confirm the run.

**APM: Run Script** appears in the Command Palette only when the setting is enabled. Interactive scripts run in their own terminal. Script tasks keep their existing environment and Git or SSH authentication; they do not receive the extension's repository credentials.

Stop any task with **Tasks: Terminate Task**. Task output stays in its terminal; native workflow logs stay in the **APM** output channel. Compilation and script tasks can change project files, so inspect the project and preview compilation when appropriate.

## Lifecycle workflows

APM lifecycle scripts run around package installs, updates, and uninstalls. Run **APM: Manage Lifecycle Workflows** from the Command Palette or **More APM Actions**, choose a project, then choose an action:

| Action | Effect | Confirmation |
| --- | --- | --- |
| **Inspect discovered lifecycle scripts** | Lists scripts APM discovers from project, user, and policy sources. | No |
| **Validate lifecycle scripts** | Checks discovered script files without running them. | No |
| **Test lifecycle event (dry run)** | Previews the scripts matching one of the six events: `pre-install`, `post-install`, `pre-update`, `post-update`, `pre-uninstall`, or `post-uninstall`. | No |
| **Execute lifecycle event scripts** | Runs the scripts for the chosen event. | Yes |
| **Trust project lifecycle scripts** | Allows the project's lifecycle block to run during installs. | Yes |
| **Revoke lifecycle trust** | Prevents the project's lifecycle block from running during installs. | Yes |
| **Add starter lifecycle block** | Adds an example block to `apm.yml`. Edit and validate it before trusting it. | Yes |
| **Replace lifecycle block (overwrite)** | Overwrites the existing lifecycle definition. | Yes |

Reports open in read-only documents. Lifecycle workflows never run during discovery or refresh.
