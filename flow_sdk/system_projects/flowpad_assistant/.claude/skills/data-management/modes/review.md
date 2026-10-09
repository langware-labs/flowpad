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

| # | Check | How to prove it |
| --- | --- | --- |
| C1 | Every kind applies: `flow schema apply <project>/agentic-assets/data_schema` exits 0, every `status: ok` | the command's output |
| C2 | Every row the project holds fits: `DM ds-validate <ds>` → `problems: []` for every dataset | the output per dataset |
| C3 | No code writes a dataset's files, computes a row id, or copies the key into the row | grep the code for `examples/`, `example.json`, `uuid5`, `data.key` |
| C4 | Datasets are found by kind (`Dataset.forKind` / `for_kind` / `DM ds-find`), never by a folder name or an id kept in code | the calls |
| C5 | Links are fields typed by the target kind holding `<kind>.id.<uuid>`; no `{type, key}` stored; nothing in git links to rows kept out of git | the schemas; a row read back |
| C6 | Every rule of the form "this link names the same row as that one" is a schema `rules` entry; other cross-row rules are written in the kinds' `description.md` and checked in every writer | the schemas; the writers |
| C7 | Every write is checked by the SDK and sends the `version` the writer read (`expected`); a refusal is shown, never swallowed | the write calls |
| C8 | Readers use `rows()` / `rows_and_problems()`: one bad row never hides the others; problems are shown | the read calls |
| C9 | Refusals are read by `details[].code`, never by parsing the message | grep for message matching |
| C10 | A field kept in step with a system outside Flowpad follows the three-way rule (`flow_sdk.datasets.merge.three_way`): never last-writer-wins; a value that names nothing here is reported, never overwritten | the sync code |
| C11 | Scripts that import `flow_sdk` run on Flowpad's interpreter and call `load_root`; a script that writes many rows takes one lock for its run | the script and its launcher |
| C12 | Tests and scripts that write leave the real project and any shared outside system as they found them, even when interrupted (a probe, or `try/finally` cleanup) | the test code |
| C13 | Docs and agent prompts say what the code does | read them against the code |

## 3. Findings — only what makes a check FAIL, ranked

- **High** — data is lost, corrupted, or a rule the project relies on is broken for some writer.
- **Medium** — a check fails in a way that produces wrong data, a wrong screen or a lost edit
  under realistic use (not a contrived sequence).
- **Low** — everything else: duplication, style, naming, a nicer helper, a hypothetical. List at
  most five, under "Backlog". **Low never fails a review.**

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

1. The checklist: C1–C13, each PASS / FAIL with its evidence.
2. Findings: High, then Medium — each with file:line and why it fails its check. "None" is an answer.
3. Backlog (Low, at most five).
4. SDK / skill gaps. 5. Questions for the owner.
5. The verdict: **PASS** (every check passes, no High or Medium) or **FAIL**.
