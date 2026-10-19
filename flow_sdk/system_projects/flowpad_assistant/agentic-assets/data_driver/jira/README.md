---
id: b0745b77-dd84-4393-b14c-5d6f94ea3732
---
# Jira

The issues one JQL query matches on a Jira Cloud site, read as a table: one record per issue,
with `key`, `title`, `status`, `assignee`, `priority`, `issue_type`, `labels`, `url`, `text`
(the description as plain text) and `published_at` (the issue's `updated`).

```python
import pandas as pd
from flow_sdk.builtin.data_source import DataSource

issues = await DataSource.get("PROJ issues")
async with await issues.open() as live:
    async for page in live.pages(page_size=100):
        df = pd.DataFrame([row.data.model_dump() for row in page.items])
        await page.ack()
```

## What you need

1. **An Atlassian account** that can see the issues. The source reads as that account, with its
   permissions — nothing it cannot see is read.

2. **An API token.** Open [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens),
   choose **Create API token**, and copy it.

3. **The** **`jira`** **credential**, declared in the owning project or the user scope, with the
   values in its `.env.local` or vault — nothing secret goes into the source's form:

   | Variable         | What                               |
   | ---------------- | ---------------------------------- |
   | `JIRA_EMAIL`     | the Atlassian account's email      |
   | `JIRA_API_TOKEN` | the token from step 2              |

   `flow credentials set jira --stdin`, then `flow credentials check jira`.

## Connect

Data Sources → Add → Jira:

* **Site** — `https://acme.atlassian.net`

* **JQL** — which issues, e.g. `project = PROJ order by updated DESC`. Left empty, every issue
  the account can see, most recently updated first.

Press **Verify**, then **Sync**.

## How it behaves

* Pages follow Jira's own `nextPageToken`; a page asks for at most 100 issues, Jira's ceiling.

* After a full pass the source keeps the newest `updated` it saw. The next pass reads only issues
  updated since then — less a day, because JQL reads dates in the account's own timezone. An
  issue read again is absorbed; none is missed.

* Changing the JQL starts over: the kept mark belonged to the old query.

* The identity is the issue id, so an issue moved to another project (a new key) is the same record.

* Comments are not read. A thread of comments is messages, not a record: that would be a driver of
  its own.

## Not supported yet

* **OAuth / the Atlassian connector.** Signing in with Atlassian instead of a token needs the
  site's `cloudId` and hub-side scopes; until then the token is the only way in.

* **Jira Server / Data Center.** Only Jira Cloud's REST v3 enhanced search is spoken.
