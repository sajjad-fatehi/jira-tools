# Changelog

## 0.1.0

- Jira Session API credential: username/password login via `POST /rest/auth/1/session`, cookie session cached in the credential, no retry on a failed login.
- Issue → Create with project/issue type/priority lists, optional fields, custom fields and a JSON escape hatch.
- Issue → Get Many with a JQL builder or raw JQL, field selection, order, Return All paging or Limit.
