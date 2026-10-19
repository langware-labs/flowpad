---
id: b0839dd8-dd27-4c71-866c-9e963239835d
---
# Mode: review — is a project's data layer right? (and fix what is not)

> **Ground rules (inline by design):**
> **1. Prove it in a probe first** (`references/probe.md`) — nothing lands in the
> user's project until the same files passed there; report the exit codes and read-backs.
> **2. An unknown kind is silently `Any`** — send one deliberately bad value; it MUST be refused.
> **3. Address rows by key; never compute an id.**
> **4. Never write a dataset's files by hand** — `dm_ctl` / the SDK, or tell the user the SDK cannot.
> **5. Schemas apply live** with `flow schema apply`; never ask for a restart.
> **6. Never widen a wait, a timeout or a retry to make something pass.**

`DM` is the shell function `DM() { "${FLOWPAD_PYTHON:-$(flow instance python)}" "<this skill>/scripts/dm_ctl.py" "$@"; }`.

A review that asks "find everything" never ends: there is always a smaller thing. This mode
asks a FIXED question — the checklist below — and ends when it is answered. A review passes
when every check passes and there is no High or Medium finding. Report a pass as a pass.

## 1. Read the project's decisions first

`<project>/docs/data-decisions.md` (create it when you fix, if absent) lists what the
project decided on purpose — a trade-off, an exception, a product choice — each with its
reason. **A decision written there is not a finding** unless it causes data loss. When you
fix, record there every finding you deliberately leave, and why.

## 2. The checklist — each one PASS or FAIL, with evidence (file:line, a command's output)

Asked only to REPORT (or told to write nothing)? Then nothing is written and no probe is made:
ground rule 1 binds section 4. C1 and C2 then take their STATIC proof, and say so.

| # | Check | How to prove it |
| --- | --- | --- |
| C1 | Every kind applies: `flow schema apply <project>/agentic-assets/data_schema` exits 0, every `status: ok`. Static: every `data_schema.json` uses the shape forms of `references/shape-forms.md` and every rule path walks link fields | the command's output; or the files, marked "static" |
| C2 | Every row the project holds fits: `DM ds-validate <ds>` → `problems: []` for every dataset. Static: read three rows per tracked dataset against their schema | the output per dataset; or the rows, marked "static" |
| C3 | No code writes a dataset's files, computes a row id, or copies the key into the row | grep the code for `rows/`, `row.json`, `uuid5`, `data.key` |
| C4 | Datasets are found by kind (`Dataset.forKind` / `for_kind` / `DM ds-find`), never by a folder name or an id kept in code. (A `mirror.dataset` in `data_source.json` IS a folder name — that is its form) | the calls |
| C5 | Links are fields typed by the target kind holding `<kind>.id.<uuid>`; no `{type, key}` stored; nothing in git links to rows kept out of git | the schemas; a row read back |
| C6 | Every rule of the form "this link names the same row as that one" is a schema `rules` entry; other cross-row rules are written in the kinds' `description.md` and checked in every writer | the schemas; the writers |
| C7 | Every write is checked by the SDK and sends the `version` the writer read (`expected`) — scripts too; a refusal is shown, never swallowed | every write call, in the app AND in each script |
| C8 | Every reader READS the problems: `rows()` answers `{rows, problems}` and `rows_and_problems()` a pair — a reader that takes only the rows, or calls `read_rows()` (it raises on one bad row), fails. Problems are shown or reported | the read calls |
| C9 | Refusals are read by `details[].code`, never by parsing the message | grep for message matching |
| C10 | A field the app's users edit that an outside system must also have is THAT SYSTEM'S field: in the mirror map, `owned_by`, written through the dataset (`references/mirroring.md`, laws 2–3). The project holds no client, key, state file, merge or "agreed value" of its own for a mirrored row | grep for the system's API host, `three_way`, a state file; the source file |
| C11 | Scripts that import `flow_sdk` run on Flowpad's interpreter and call `load_root`; a script that writes takes `single_run(project_root, "<name>")` around its whole run — never a lock file of its own, never none | the script and its launcher |
| C12 | Tests and scripts that write leave the real project and any shared outside system as they found them, even when interrupted (a probe, or `try/finally` cleanup). A test that edits a REAL record of a live outside system is a Medium even with cleanup and even when recorded as a decision (a kill skips the cleanup: that IS data loss); a test that makes and deletes its OWN named record passes | the test code |
| C13 | Docs, comments and agent prompts say what the code does | read them against the code |
| C14 | A dataset that mirrors an outside system is the DECLARED mirror (`"mirror"` in a `data_source.json`) and the ONLY one — no script also mirrors it; its schema marks every mapped field `owned_by` that source's `by`, as open shapes (`?string`), not `enum:`; the app shows them read-only by reading `kindForm`, never from its own list of field names. An open outside value is never used as a KEY of a closed shape (a stage name as a key of `{"won": "?date"}`). A row a `"by": "key"` link names is never renamed without the outside system (`references/mirroring.md`) | the source file, the schema, the app's and scripts' code |
| C15 | A rule on `dataset.rows.changed` names its rows by KIND — `"tag": {"on": "dataset.rows.changed", "scope": ["kind:<full kind>"]}` — in the tracked `trigger.json`; no dataset id is generated into it per machine. `run_script` is project-relative. (`tag.target` in the file is the row's `tag_target`) | the trigger files; nothing rewrites them |
| C16 | More than one machine: every trigger either says where it runs (`"runs_on"`) or is harmless when every clone runs it. Anything kept out of git that the project treats as shared (a "told already" ledger, a stamped date) fails | the trigger files; `.gitignore` against what scripts write |
| C17 | A field only a script may write has an owner — `"owned_by": "<word>"`, the script writes `by="<word>"` — so the app cannot change it and need not list it | the schema; the app |
| C18 | The app LISTENS (`onRowsChanged`), never polls or re-reads on focus; it shows a write's `warnings` and a broken mirror (`DataSource.isMirrorBroken`) | grep `setInterval`, `visibilitychange`, `warnings`, `isMirrorBroken` |
| C19 | A script a rule runs is `then.run_script` (a failed step is a failed run), finishes inside the step's budget or starts the work and returns; "run now" follows `Trigger.run(started.run_id)`, never a status file of its own. A pruning `sync` in a script refuses an empty answer it cannot tell from an outage | the trigger files; the scripts |
| C20 | The driver side passes `connect-data-source` author mode's rules: it never invents a value for a field the system owns, every `Mutable` verb answers `warnings` for a part it could not set — a failed read-back included — and never raises after the record changed, and a listing that got no answer raises. Related resources reuse one configurable driver and shared transport; separate drivers have a concrete family/transport justification ([recipe](../../connect-data-source/references/configurable-drivers.md)) | driver manifests and helper modules as well as `source.py`; compare authentication, HTTP and pagination code across folders; report copied transport as Low unless it already causes a High/Medium failure |

## 3. Findings, ranked — a check FAILS only on a High or Medium finding

- **High** — data is lost, corrupted, or a rule the project relies on is broken for some writer.
- **Medium** — a check fails in a way that produces wrong data, a wrong screen or a lost edit
  under realistic use (not a contrived sequence).
- **Low** — everything else: duplication, style, naming, a nicer helper, a hypothetical. List at
  most five, under "Backlog". **Low never fails a check or the review** — a check with only Low
  findings is a PASS.

**Not findings** (report them in their own short sections, never in the ranking):
- a gap in the SDK or this skill — "SDK / skill gaps", for the SDK's owners;
- a product question only the owner can answer ("must a deal's channel match its message's?") —
  "Questions for the owner";
- anything `docs/data-decisions.md` records, unless it loses data.

## 4. Fixing (when asked to fix)

Fix every High and Medium, in the project only, the way the other modes do (probe first,
migrate rows through the SDK). Leave Low alone unless it is a one-line change in a file you
are already editing. Record what you leave in `docs/data-decisions.md`. Then re-run the
checklist and report it.

## 5. The report

1. The checklist: C1–C20, each PASS / FAIL (or NOT RUN, with why) and its evidence.
2. Findings: High, then Medium — each with file:line and why it fails its check. "None" is an answer.
3. Backlog (Low, at most five).
4. SDK / skill gaps.
5. Questions for the owner.
6. The verdict: **PASS** (every check passes, no High or Medium) or **FAIL**.
