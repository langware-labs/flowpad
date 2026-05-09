# Action: search

Search local files, skills, agents, specs, plans, tasks, markdown docs, claude sessions, and any other indexed records via SQLite FTS5. Use this whenever the user asks to **find**, **look up**, **search for**, or **show me X** without giving an explicit TypeId.

This is a read-only discovery action — it never writes to disk, never mutates the DB. Compose it with `navigate` to open whatever the user picks.

## How to search

```bash
flow record search "<query>" <time> <limit>
```

All three arguments are required positional.

| Arg | Meaning |
| --- | --- |
| `query` | Search text. FTS5 syntax allowed: `task`, `release notes`, `plan AND auth`, `kwa*`. Quote phrases. |
| `time`  | Window for `modified_at`: `all` / `0` (no filter), `1h`, `6h`, `12h`, `1d`, `7d`, `1w`, `1m`. |
| `limit` | Max results (>= 1). Pick something the user can read — usually 5–20. |

Defaults to use when the user is vague: `time=all`, `limit=10`.

## Output

Success — exit 0, single JSON line:

```json
{
  "ok": true,
  "query": "release notes",
  "time": "1w",
  "limit": 10,
  "indexer_ready": true,
  "total": 3,
  "results": [
    {
      "record_id": "...",
      "record_type": "task",
      "name": "Write release notes",
      "snippet": "…<mark>release</mark> notes…",
      "status": "to_do",
      "scope": "",
      "asset_ref": "/abs/path/to/source/file",
      "created_at": "...",
      "modified_at": "..."
    }
  ]
}
```

`record_type` + `record_id` together form the TypeId (`<record_type>-<record_id>`) — pass that to [`navigate.md`](navigate.md) to open one.

`snippet` is FTS-highlighted with `<mark>…</mark>` around matched terms. Strip the markers when echoing back to the user.

`asset_ref` is the underlying source file (manifest.json, .md, .jsonl, …). Read it directly with the `Read` tool when the user asks for the contents of a hit, instead of fetching through more CLI calls.

## Exit codes

| Exit | Meaning |
| ---- | ------- |
| `0`  | OK — JSON on stdout. |
| `2`  | Bad arguments (empty query, unknown `time` value, `limit < 1`). |
| `5`  | Cannot reach the Flowpad server. |

## Patterns

### "Find X and open it"

1. `flow record search "<X>" all 5`
2. If `total == 0`, tell the user nothing matched. Stop.
3. If `total == 1`, treat it as the answer.
4. If `total > 1`, pick the best match by name/recency and tell the user *"found N — opening the most recent: <name>"* before navigating.
5. Pass `<record_type>-<record_id>` to `flow navigate entity`. See [`navigate.md`](navigate.md).

### "What did I work on today / this week?"

`flow record search "" 1d 20` — empty query plus a tight `time` window leans on the browse path (recent rows ordered by `updated_date desc`), filtered to the requested time.

If the user mentions a type (*"any tasks I touched today"*), filter the results yourself by `record_type == "task"` after the call returns. Don't try to pass type filters through this CLI — only `query`, `time`, and `limit` are wired.

### Disambiguating

When several rows have the same `name` (common for things named after files, e.g. `electron.md`), use `asset_ref` to disambiguate to the user. Don't navigate without confirmation when the user's phrasing is ambiguous.

## When to stop

After printing the result list (or opening the chosen item), stop. Don't run extra `flow record search` calls to "verify" — the FTS table is the source of truth, and a second query against the same window will return the same rows.