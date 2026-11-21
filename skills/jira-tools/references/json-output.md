# JSON output and `jq` patterns

Read this when parsing `jira-tools -json` output. With `-json`, commands print the raw Jira REST response; `boards` and `sprints` print a merged list instead. Field names below are the ones `jira-tools` itself reads from the API.

## Shapes

| Command | Top-level shape |
|---|---|
| `search` | `{ total, issues: [ { key, fields } ] }`; `fields` holds only `summary`, `issuetype`, `status`, `assignee` |
| `issue` | `{ key, fields }`; `fields` holds only the ones listed below (no attachments) |
| `attachments` | `{ key, fields: { attachment: [] } }`; each attachment: `id`, `filename`, `size`, `content` (download URL), `created`, `author` |
| `transitions` | `{ transitions: [ { id, name, to: { name } } ] }` |
| `issuetypes` | `{ key, name, issueTypes: [ { id, name, subtask, description } ] }` |
| `create` | `{ key, ... }` |

`issue` fields requested by the tool: `summary`, `issuetype.name`, `status.name`, `priority.name` (nullable), `assignee` and `reporter` (nullable; `name`, `displayName`), `created`, `updated`, `description`, `comment.total`, `comment.comments[]` (`id`, `author`, `body`, `created`; `id` is what `comment-delete -id` needs), `parent`, `subtasks[]`.

Nullable fields (`assignee`, `priority`, `parent`) need `// "none"` or `?` guards in `jq`.

## Patterns

```bash
jira-tools -json search -jql 'project = PROJ' -max 50 | jq -r '.issues[] | [.key, .fields.status.name, (.fields.assignee.name // "unassigned"), .fields.summary] | @tsv'
jira-tools -json issue PROJ-123 | jq '{key, summary: .fields.summary, status: .fields.status.name, subtasks: [.fields.subtasks[]? | .key]}'
jira-tools -json issue PROJ-123 | jq -r '.fields.comment.comments[] | "\(.id) \(.author.displayName): \(.body)"'
jira-tools -json attachments PROJ-123 | jq -r '.fields.attachment[]? | "\(.id)\t\(.filename)\t\(.size)"'
jira-tools -json transitions PROJ-123 | jq -r '.transitions[] | "\(.id)\t\(.name) -> \(.to.name)"'
jira-tools -json issuetypes -project PROJ | jq -r '.issueTypes[] | select(.subtask) | .name'
```

If a `jq` path fails on your instance, inspect the shape with `jq 'keys'` and adjust; do not assume.
