# n8n-nodes-jira-session

n8n community node for **Jira Server / Data Center** that logs in with a **username and password** (cookie session) instead of an API token or Basic auth header.

Some self-hosted Jira instances sit behind a proxy that drops the `Authorization` header, so Basic, Bearer and personal access token auth all come back as `anonymous` / HTTP 401. n8n's built-in Jira node only offers header-based auth (Cloud OAuth2, Cloud API token, Server email + password as Basic auth), so it fails on such instances. This node does what the [`jira-tools`](../README.md) CLI does: `POST /rest/auth/1/session` with JSON `username`/`password`, then sends the returned cookies (`JSESSIONID` and any others) as `Cookie` on every call. It also works on instances where header auth is fine.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) · [Examples](#examples) · [Limitations](#limitations) · [Development](#development)

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

- **n8n UI** (self-hosted, owner/admin): *Settings → Community Nodes → Install*, package name `n8n-nodes-jira-session`. This needs the package on npm.
- **Manual** (self-hosted, e.g. Docker), from npm or from a tarball you built:

  ```bash
  # inside the n8n container / host, as the n8n user
  mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes
  npm install n8n-nodes-jira-session            # from npm
  # or: npm install --legacy-peer-deps /path/to/n8n-nodes-jira-session-0.1.0.tgz
  ```

  Then restart n8n. Build a tarball from this folder with `npm ci && npm run build && npm pack`.

  `--legacy-peer-deps` stops npm from installing its own copy of the `n8n-workflow` peer dependency (n8n provides it).

## Credentials

Create a **Jira Session API** credential:

| Field | Example | Notes |
|---|---|---|
| Base URL | `https://jira.example.com` | Root of the Jira instance, without `/rest`. A trailing `/` is fine. |
| Username | `jdoe` | Jira username (not the e-mail address, unless that is your username). |
| Password | | Stored encrypted by n8n like any credential secret. |

How the session works:

- The first request logs in with `POST /rest/auth/1/session` and stores the session cookie in a hidden, expirable field of the credential. Later requests and later executions reuse it, so a workflow does not log in on every run.
- When Jira answers a request with HTTP 401 (session expired or Jira restarted), n8n logs in once more and resends that request.
- A login answered with anything other than HTTP 200 fails the node with `Jira login failed: HTTP 401 (AUTHENTICATED_FAILED) ...` and is **never retried**, because repeated failed logins trigger Jira's CAPTCHA lockout. If the reason says `AUTHENTICATION_DENIED`, Jira wants a CAPTCHA: log in once in a browser, then run again.
- **Test** in the credential dialog always performs a fresh login and then calls `GET /rest/api/2/myself`.
- Write requests carry `X-Atlassian-Token: no-check` (Jira's XSRF check).
- Each credential holds one session. Two workflows using the same credential at the same time share it.

## Operations

Resource **Issue**:

### Create

| Parameter | Notes |
|---|---|
| Project | Loaded from `GET /rest/api/2/project`, or a project key via expression. |
| Issue Type | Loaded per project from `GET /rest/api/2/project/{key}`, or an issue type ID via expression. |
| Summary | Required. |
| Additional Fields | Description (wiki markup), Assignee and Reporter (usernames), Priority (loaded from `GET /rest/api/2/priority`), Labels and Components (comma-separated), Parent Issue Key (for sub-tasks), Due Date, **Additional Fields (JSON)**. |
| Custom Fields | Pairs of field ID (`customfield_10010`) and value. A value that parses as JSON is sent as JSON (`5`, `{"value": "High"}`, `["a","b"]`, `[{"name": "Team A"}]`); anything else is sent as text. Wrap a value in quotes (`"123"`) to send a number-like value as text. |

**Additional Fields (JSON)** is merged into the `fields` object last, so it can set any field the form does not cover and overrides form values, e.g. `{"customfield_10020": {"id": "7"}, "environment": "staging"}`.

Output, one item per input item:

```json
{ "id": "10123", "key": "PROJ-42", "self": "https://jira.example.com/rest/api/2/issue/10123", "url": "https://jira.example.com/browse/PROJ-42" }
```

### Get Many (search)

Uses `POST /rest/api/2/search`. Output: one n8n item per issue (`id`, `key`, `self`, `fields`).

| Parameter | Notes |
|---|---|
| Filter Mode | **Builder** composes JQL from the filters; **Raw JQL** sends your query unchanged. |
| Filters (Builder) | Project (keys), Status, Issue Type, Assignee, Labels: comma-separated lists, matched with `=` for one value and `in (...)` for several. Assignee `currentUser()` means the logged-in user. Updated Since (`updated >= "yyyy-MM-dd HH:mm"`, Jira user's time zone). Text Contains (`text ~ "..."`). Filters are joined with `AND`; every value is quoted and escaped, so input cannot change the query structure. |
| Order By / Order Direction (Builder) | Field name such as `updated`, `created`, `priority`, `key`, `cf[10010]`. Empty for no ordering. In Raw JQL mode put `ORDER BY` in the query. |
| Fields to Return | Comma-separated. Default `summary,status,assignee,issuetype,priority,created,updated`. `*all` or `*navigable` also work. |
| Return All / Limit | Return All pages with `startAt` / `maxResults` (100 per page) until Jira's `total` is reached; otherwise stop at Limit (default 50). |

Example builder result: Project `PROJ`, Status `To Do, In Progress`, Labels `n8n`, ordered by `updated` →

```text
project = "PROJ" AND status in ("To Do", "In Progress") AND labels = "n8n" ORDER BY updated DESC
```

Both operations support **Continue On Fail**: a failing item outputs `{ "error": "..." }` and the others still run. HTTP errors show Jira's `errorMessages` / `errors` in the error description.

## Examples

[`examples/create-and-search.workflow.json`](examples/create-and-search.workflow.json): import it with *Workflows → Import from File*, then pick your Jira Session credential on the three Jira nodes and adjust project/issue type/priority IDs. It:

1. creates a `PROJ` task with description, labels, priority, due date, one custom field and a JSON extra field,
2. searches the created issue with the builder (project, label, text),
3. lists every `PROJ` issue with raw JQL and Return All.

## Limitations

- Jira Server / Data Center, REST API v2 (tested against the 8.x API shape). Jira Cloud does not support `/rest/auth/1/session` with a password; use n8n's built-in Jira node there.
- Only Issue → Create and Issue → Get Many. No update, transition, comment, attachment or trigger yet.
- Search uses `POST /rest/api/2/search`, which Jira Data Center 10+ still offers; very large `Return All` result sets are fetched page by page into memory.
- Accounts with two-factor auth or SSO-only login (no Jira password) cannot use session login.
- Not available on n8n Cloud unless the package is published and verified by n8n.

## Development

Requires Node.js 22+ and npm. Standard [`@n8n/node-cli`](https://docs.n8n.io/integrations/creating-nodes/build/n8n-node/) tooling:

```bash
cd n8n
npm ci
npm run build      # n8n-node build → dist/
npm run lint       # n8n community node linter
npm test           # unit tests with mocked HTTP (node:test + tsx)
npm run dev        # n8n with this node loaded, rebuilds on change
```

### Mock Jira for end-to-end checks

`mock-jira/server.mjs` is a small in-memory Jira (no dependencies). Like the instances this node targets, it ignores the `Authorization` header and only accepts the cookie from `POST /rest/auth/1/session` (user `jdoe`, password `secret`). It implements `myself`, `project`, `project/{key}`, `issue/createmeta`, `priority`, `POST issue` (checks the XSRF header), `POST search` with paging, and `GET /__log` (routes called, whether a cookie was sent).

```bash
npm run mock-jira            # http://localhost:8089, or: node mock-jira/server.mjs <port>
```

End-to-end run in Docker (what was used to verify this package):

```bash
npm run build && npm pack --pack-destination /tmp/n8n-e2e
docker run -d --name n8n-e2e -p 5678:5678 -v /tmp/n8n-e2e:/e2e \
  --add-host host.docker.internal:host-gateway docker.n8n.io/n8nio/n8n:2.48.7
docker exec n8n-e2e sh -c 'mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes && npm init -y >/dev/null \
  && npm install --legacy-peer-deps /e2e/n8n-nodes-jira-session-0.1.0.tgz'
docker restart n8n-e2e
# open http://localhost:5678, create a Jira Session credential with Base URL
# http://host.docker.internal:8089, user jdoe / secret, import the example workflow and run it
docker rm -f n8n-e2e
```

### Releasing

Releases run from GitHub Actions so the npm package carries [provenance](https://docs.npmjs.com/generating-provenance-statements), which n8n requires for verified community nodes.

1. On npmjs.com, the package has a **trusted publisher** for GitHub Actions: repository `sajjad-fatehi/jira-tools`, workflow `publish-n8n.yml`. No npm token is stored in the repo.
2. In GitHub: *Actions → Publish n8n node → Run workflow* on `main`, pick the bump (`patch`, `minor`, `major`, or `none` to publish the version already in `package.json`).
3. The workflow lints, builds and tests, bumps `n8n/package.json`, commits and tags `n8n-vX.Y.Z`, publishes to npm and creates a GitHub release.

`npm publish` from a local machine is blocked on purpose (`prepublishOnly` runs `n8n-node prerelease`).
