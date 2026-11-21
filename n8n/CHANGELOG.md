# Changelog

## Unreleased

- Node version 2 (default for new nodes; version 1 workflows unchanged): Issue → Create shows every field of the project + issue type create screen in a **Fields** resource mapper, built from Jira create metadata (paged endpoint, legacy fallback), with required flags, types and allowed values.
- Assignee and Reporter pickers with type-ahead user search (`user/assignable/search`, `user/search`) or a username.
- Mock Jira: create metadata (new + legacy), user search, required-field validation, `GET /__last-create`.

## 0.1.0

- Jira Session API credential: username/password login via `POST /rest/auth/1/session`, cookie session cached in the credential, no retry on a failed login.
- Issue → Create with project/issue type/priority lists, optional fields, custom fields and a JSON escape hatch.
- Issue → Get Many with a JQL builder or raw JQL, field selection, order, Return All paging or Limit.
