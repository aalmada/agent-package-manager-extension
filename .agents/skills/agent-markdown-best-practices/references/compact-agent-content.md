# Compact Agent Content

## Content Decisions

| Need | Best Form |
| --- | --- |
| Ordered actions | Numbered workflow with concrete verbs |
| Commands or comparable facts | Table or compact bullet list |

Use prose when sequence, rationale, or nuance would be distorted by a table. Tables are a compression tool, not a default decoration.

## Precision Rules

| Concern | Rule |
| --- | --- |
| Obligation | Use `must` for requirements, `should` for recommendations, and `may` for options |
| Completeness | State the action and target; add the condition or expected result when it affects execution or completion |
| Scope | Identify which files, tasks, tools, or circumstances a rule governs |
| Exceptions | Place an exception beside the rule it modifies |
| Precedence | State which instruction wins when rules can conflict |
| Terminology | Use one consistent term for each concept |
| Criteria | Replace subjective terms such as "properly" or "as needed" with observable conditions |
| Specificity | Replace ambiguous pronouns with the command, file, tool, or result they name |
| Prohibitions | Name the required alternative or fallback when one exists |

## Compression Decisions

- Keep rationale only when it changes how an instruction should be applied.
- Keep examples only when they disambiguate syntax or behavior.
- Convert generic callouts such as "Note," "Important," and "Remember" into direct rules.
- Keep independent requirements separate when combining them would make conditions or precedence harder to parse.
