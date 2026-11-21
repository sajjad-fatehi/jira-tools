# jira-tools

[![n8n node on npm](https://img.shields.io/npm/v/n8n-nodes-jira-session?label=n8n%20node&logo=npm)](https://www.npmjs.com/package/n8n-nodes-jira-session)
[![npm downloads](https://img.shields.io/npm/dm/n8n-nodes-jira-session?logo=npm)](https://www.npmjs.com/package/n8n-nodes-jira-session)
[![Go version](https://img.shields.io/github/go-mod/go-version/sajjad-fatehi/jira-tools?logo=go)](go.mod)

Command-line client for self-hosted Jira Server / Data Center (REST API v2 and Agile API 1.0). Written in Go, standard library only, no dependencies.

## Why session auth

Some Jira Server instances sit behind a proxy that drops the `Authorization` header, so Basic and Bearer (PAT) auth both come back as `anonymous`. jira-tools therefore logs in once per run with `POST /rest/auth/1/session` (JSON `username`/`password`) and sends the returned `JSESSIONID` cookie on every call. This works whether or not header auth is available. Sessions are not cached across runs. A failed login stops with an error and is never retried, because repeated failures can trigger Jira's CAPTCHA lockout. The password and cookie are never printed or logged.

## Install

Requires Go (see `go.mod`).

```bash
make install        # builds and copies to ~/.local/bin/jira-tools
jira-tools version
```

Other targets: `make build`, `make test`, `make vet`, `make clean`.

## Config

| Variable | Example |
|---|---|
| `JIRA_BASE_URL` | `https://jira.example.com` |
| `JIRA_USERNAME` | your Jira username |
| `JIRA_PASSWORD` | your Jira password |

Environment variables win. Missing ones are read from an env file, so the binary works from any directory. The env file is chosen in this order:

1. `-env-file <path>`
2. `$JIRA_TOOLS_ENV_FILE`
3. `$XDG_CONFIG_HOME/jira-tools/.env`
4. `~/.config/jira-tools/.env`

A missing default file is ignored (all values may come from the environment); a missing file given by `-env-file` or `JIRA_TOOLS_ENV_FILE` is an error. Keep the file mode 600.

```bash
mkdir -p ~/.config/jira-tools
cat > ~/.config/jira-tools/.env <<'EOF'
JIRA_BASE_URL=https://jira.example.com
JIRA_USERNAME=jdoe
JIRA_PASSWORD=...
EOF
chmod 600 ~/.config/jira-tools/.env
jira-tools me
```

## Global flags

Accepted before or after the command name:

- `-json` print the raw API JSON instead of the text view
- `-env-file <path>` env file to use

Write commands (`create`, `attach`, `attachment-delete`, `comment`, `comment-delete`, `transition`, `assign`) also take `-dry-run`: print method, path and JSON body (if any), send nothing. `transition -to <name>` still does a read-only GET of the issue's transitions to resolve the name (numeric ids need no network).

Flags are single-dash Go flags (`-json`, also accepted as `--json`). An issue key may come before or after the flags and is case-insensitive.

## Commands

```bash
jira-tools me
jira-tools projects
jira-tools search -jql 'project = PROJ ORDER BY updated DESC' -max 5  # default -max 20
jira-tools search -sprint active -jql 'assignee = currentUser()'      # -sprint: active | <sprint id>, ANDed with -jql
jira-tools boards -type scrum                                         # id, name, type
jira-tools sprints                                                    # active sprints of all scrum boards, deduplicated
jira-tools sprints -board 10 -state future                            # -board: id or name; state active|future|closed
jira-tools issue PROJ-123                                             # details, parent, subtasks, last 5 comments
jira-tools issuetypes -project PROJ                                   # id, name, SUBTASK yes/no (read-only)
jira-tools create -project PROJ -type Task -summary "Fix X" -description "Details" -assignee jdoe
jira-tools create -parent PROJ-123 -type <subtask type> -summary "Step 1"   # subtask; -project defaults to the parent's
jira-tools attach PROJ-123 -file shot.png -file log.txt               # upload attachments; prints id, name, size
jira-tools attachments PROJ-123                                       # id, name, size, created, author (-json: raw)
jira-tools attachment-download 10001 -out /tmp/report.pdf             # save one attachment to a NEW file (never overwrites; URL must stay under the Jira base URL)
jira-tools attachment-delete 10001 -dry-run                           # DELETE one attachment by id; -dry-run sends nothing
jira-tools comment PROJ-123 -body "Looking into it"
jira-tools comment-delete PROJ-123 -id 10100                          # DELETE one comment by id
jira-tools transitions PROJ-123                                       # id, name, target status
jira-tools transition PROJ-123 -to "In progress"                      # transition name, target status name or id
jira-tools assign PROJ-123 -user jdoe
jira-tools version
jira-tools <command> --help
```

Preview a write:

```bash
jira-tools comment PROJ-123 -body "hi" -dry-run
# POST /rest/api/2/issue/PROJ-123/comment
# { "body": "hi" }
```

Sprints and boards (Agile API, read-only):

```bash
jira-tools sprints
# ID   NAME       START→END              BOARDS
# 123  Sprint 26  2026-11-02→2026-11-16  Team board, Development

jira-tools search -sprint active -jql 'assignee = currentUser()' -max 50
# runs: (assignee = currentUser()) AND sprint in openSprints()
```

`-sprint 123` adds `sprint = 123`; an existing `ORDER BY` stays last. `-jql` may be omitted when `-sprint` is given. For `boards`/`sprints`, `-json` prints the collected list (all pages merged; sprints include the joined `boards` names).

`create` prints the new key and its `/browse/<KEY>` URL. With `-parent <KEY>` it sends `fields.parent.key`, so `-type` must be one of the project's subtask types; list them with `issuetypes` (rows marked `yes` in SUBTASK). `-project` is taken from the parent key prefix when omitted.

`attach` posts each `-file` as a multipart `file` part to `/rest/api/2/issue/<KEY>/attachments` with `X-Atlassian-Token: no-check` (Jira's XSRF guard). Files are validated first, nothing is sent if one is missing. `-dry-run` prints the method, path and the file list.

`issue` also requests `parent` and `subtasks`: the text view shows a `Parent:` line and a `Subtasks (N):` list (key, status, summary). `attachments <KEY>` reads `GET /rest/api/2/issue/<KEY>?fields=attachment`. `attachment-delete <ID>` (digits only) first does a read-only `GET /rest/api/2/attachment/<ID>` so a wrong id fails before deleting and the output names what was removed (`Deleted attachment <ID> (<name>, <size> bytes)`), then sends `DELETE /rest/api/2/attachment/<ID>` as the logged-in user. With `-dry-run` it only prints `DELETE <path>` and makes no request at all.

## AI agent skill

`skills/jira-tools/` is an Agent Skill (`SKILL.md` plus a `references/` folder) that teaches an AI coding agent to drive this CLI: commands, config, safe-use rules (write commands only on request, `-dry-run` first, never print credentials), recipes and `jq` patterns. The skill needs the `jira-tools` binary on `PATH` (see Install) and a working config (see Config).

Claude Code loads skills from a `skills/` folder inside `.claude`. From a clone of this repo, pick one:

```bash
# user-level, every project (symlink: updates with git pull)
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/jira-tools" ~/.claude/skills/jira-tools

# project-level, run inside your project (copy: commit it with the project)
mkdir -p .claude/skills
cp -R /path/to/jira-tools/skills/jira-tools .claude/skills/
```

Result: `~/.claude/skills/jira-tools/SKILL.md` (or `.claude/skills/jira-tools/SKILL.md`). Start a new Claude Code session and the skill loads when you talk about Jira issues.

Other agents that read the open `SKILL.md` format: copy or symlink the `skills/jira-tools` folder into that agent's skills directory, keeping the folder name `jira-tools` and the `SKILL.md` and `references/` layout. Check your agent's documentation for the directory; none are listed here because only the Claude Code layout above has been verified.

## n8n node

`n8n/` holds `n8n-nodes-jira-session`, an n8n community node that logs in the same way (username and password, cookie session) and can create issues and search issues with filters or JQL. It is a separate npm package and does not affect the Go build. Install, credential setup and examples: [`n8n/README.md`](n8n/README.md).

## Out of scope

Deleting anything other than single attachments, worklogs, creating/editing sprints, moving issues between sprints, velocity/reports, bulk operations, editing arbitrary fields, TUI.
