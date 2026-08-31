---
type: markdown_index
id: markdown_index-bd7ef5f5-cf38-55ee-b3c9-b1549c57f267
inputs_hash: 8242b1e65095f95fd949084344ead78876282e9c4235ed68e521233ee87f5369
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: "2026-08-23T22:11:28.823621+00:00"
latest_process_ref: ''
file_count: 7
subfolder_count: 0
---

# breadcrumbs

## Self-Summary
> Breadcrumb rules bound to failing tests: each page states the expected behaviour, internals, invariants and failure modes for one proven bug — chat activity readout, bootstrap's default project, dev port picking, SQLite NULL ordering, served HTML encoding, terminal bidi, and worker interpreter resolution.

## Files
- [Agent activity readout rules](agent_activity_readout.md) — Breadcrumb rules for the chat activity line: naming the current operation, coarse worker-phase fallback, the 500ms floor, and refinement pass-through invariants.
- [Bootstrap's default_project — which project a machine opens](bootstrap_default_project.md) — Breadcrumb rules for which project a machine opens: browser memory outranks the server, then bootstrap's strict per-caller source order, never cached.
- [Dev port picking for agent-started servers](dev_port_picking.md) — Breadcrumb rules for agent-started dev servers: request a port via flow app free-dev-port, one probe per invocation, and no lease against concurrent pickers.
- [NULL sort order in the SQLite driver](null_sort_order.md) — Breadcrumb rules for SQLite ordering on a field some entities lack: bucket tuples place missing values first, and never coerce them to empty string.
- [Served app HTML must be read as UTF-8](served_html_encoding.md) — Breadcrumb rules for serving a micro-app index.html byte-faithfully as UTF-8 whatever the host codepage, asserting the served text matches disk.
- [Terminal RTL/bidi rendering contract](terminal_bidi.md) — Breadcrumb rules for terminal RTL and bidi: a right-to-left sweep must yield PTY emission order, and why !important and avoiding inline-block are load-bearing.
- [Worker interpreter resolution](worker_interpreter.md) — Breadcrumb rules for worker interpreter resolution: FLOWPAD_PYTHON is handed to the worker as an absolute path and used verbatim from any working directory.
