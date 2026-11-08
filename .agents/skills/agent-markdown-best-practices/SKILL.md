---
name: agent-markdown-best-practices
description: "ALWAYS use when writing or reviewing agent-facing Markdown, including project instructions, skills and references, and custom-agent definitions. Covers only their shared content style: compact executable instructions, scannable information, active language, factual precision, and token efficiency. DO NOT USE FOR: artifact-specific structure, routing descriptions, metadata schemas, or prompt-body requirements; general Markdown documents; Markdown syntax or rendering rules."
---

# Agent Markdown Best Practices

Agent-facing Markdown is operational context. Keep explanation when it changes interpretation or behavior; remove words that do not.

## Core Rules

| Rule | Do | Don't |
| --- | --- | --- |
| Executable over descriptive | "Run `pnpm test`" | "Make sure tests pass" |
| Concrete over aspirational | Record verified commands and enforced conventions | Describe practices the project does not follow |
| Active and imperative | "Inspect the diff" | "The diff should be inspected" |
| No preamble | Start with the role, rule, or first useful section | "This file describes..." |
| No restatement | Let headings, structured fields, and code express what they already say | Repeat metadata or section titles in prose |
| Structured over discursive | Use a table, short list, or numbered protocol for scannable facts | Hide operational facts in long paragraphs |
| Avoid duplicate sources | Keep required instructions local; link supporting detail that remains available at use time | Copy nonessential background or policy prose into agent context |
| One purpose per section | Split unrelated concerns under clear headings | Mix independent rules in one block |

Compactness never removes a command, flag, constraint, caveat, or prerequisite that changes behavior. Cut words, not facts.

## Workflow

1. Verify claims against the repository, tool, or documented behavior; remove generic placeholders and aspirational rules.
2. Apply the precision and compression rules to prose, instructions, and examples.
3. Remove repeated conclusions, obvious callouts, and history that does not affect execution.

## Reference Files

| File | Load When |
| --- | --- |
| [references/compact-agent-content.md](references/compact-agent-content.md) | Structuring or tightening any agent-facing Markdown |