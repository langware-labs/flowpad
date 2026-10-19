---
id: 396c9997-9880-428b-a2db-0c36dd786a2e
name: locit
description: Localization lens — scan the lingui .po catalogs for target-locale strings
  that are untranslated or gone stale (English source changed in git), then translate
  each one through a research→review agent pair and write SOTA translations back into
  every locale file with a summary + detailed report.
tags: ''
version: 1
---

# Locit — translate the message catalogs

Locit closes the loop on `ui/src/locales/`: it finds what still needs
translating in the non-English catalogs, produces a state-of-the-art
translation for each string through a two-stage agent pipeline
(**haiku researcher → sonnet reviewer**), writes the results back into every
locale `.po`, and reports what changed.

Source locale is **`en-US`** (lingui `sourceLocale`); the target locales are
every other dir under `ui/src/locales/` that is not an `en*` locale
(currently `ar`, `he`). Direction/RTL is not locit's concern — it only fills
`msgstr` values.

This file routes and owns the top-level pipeline. Load an agent prompt only
when you are about to launch that agent.

## Arguments

`locit [<locale>…] [--limit N] [--ref REV] [--stale-only|--untranslated-only]`

* no args → every target locale, every pending string.
* `locit he` / `locit he ar` → restrict to those locales.
* `--limit N` → only the first N work items (use for a trial run first).
* `--ref REV` → git base for staleness detection (default `HEAD`).

The catalogs are large (thousands of empty entries when a locale is new). If
the scan returns more than ~50 items and the user did not pass `--limit` or a
narrowing filter, **stop and confirm scope** before spawning the fleet — a full
run is a lot of agents and web searches. Offer `--limit` for a trial batch.

## Pipeline

### 1 — Scan (deterministic, no model)

Run the work-list generator from the repo root:

```bash
python3 .claude/skills/locit/scan.py [--locales-dir ui/src/locales] [--ref HEAD]
```

It prints a JSON array; each item is one `(locale, msgid)` needing work:

| field         | meaning                                                        |
| ------------- | ------------------------------------------------------------- |
| `locale`      | target locale to write (`ar`, `he`, …)                        |
| `msgid`       | the source key = English text                                 |
| `source_text` | authoritative English display text (en-US `msgstr`)           |
| `reason`      | `untranslated` (empty msgstr) or `stale` (en-US source changed) |
| `current`     | existing msgstr — empty for untranslated, stale text for stale |
| `refs`        | `#:` source file(s) — the in-app context for the string       |
| `comments`    | `#.` extracted notes (e.g. placeholder meanings)              |

Apply `--limit` / locale filters yourself over this array. Save the (possibly
filtered) array to `<scratchpad>/locit_work.json`.

### 2 — Translate (fan out: researcher → reviewer, per item)

For each work item launch **one haiku researcher agent** (`agents/researcher.md`).
The researcher, for its assigned string, itself:

1. **Web-searches** the string for a proper semantic translation and proposes
   **10 candidate translations** in the target language.
2. **Summarizes the meaning** — what the string does in the app (from `refs` /
   `comments`), and the translation context (UI surface, tone, placeholders).
3. **Launches the sonnet reviewer** (`agents/reviewer.md`) with that context +
   the 10 candidates; the reviewer applies its own judgment and knowledge and
   returns the single SOTA translation.
4. **Returns the structured result** (final + all intermediates).

Batch to control fan-out: pass **one source file's strings (grouped by `refs`)
per researcher** so shared UI context is researched once, rather than one agent
per string. Run researchers in parallel across batches. Preserve every
`{placeholder}` / `{0}` token verbatim in translations — never translate or drop
them.

> For a large run, drive this with the **Workflow** tool: `pipeline` the work
> batches through a researcher stage then a reviewer stage. The nested
> "researcher launches reviewer" shape the user asked for is preserved by having
> the researcher call the reviewer as its own sub-agent; the workflow form is an
> equivalent, more observable way to run the same two stages. Either is fine.

### 3 — Collect, apply, report

1. Assemble every reviewer verdict into a results array
   `[{ "locale", "msgid", "translation" }, …]` at `<scratchpad>/locit_results.json`.
2. Write them back — surgical, one `msgstr` per entry, formatting preserved:

   ```bash
   python3 .claude/skills/locit/apply.py <scratchpad>/locit_results.json
   ```

   It reports `applied N/M` per locale and any `MISSING` msgids (skipped —
   never invent an entry). Verify the git diff touches only `msgstr` lines.
3. Produce the two-part report (`report.md` describes the exact shape):
   * **Summary** — per locale: counts translated / stale-refreshed / skipped.
   * **Detailed report** — per string: the 10 candidates, the meaning summary,
     the reviewer's chosen translation, and its rationale.

## Ground rules

* **Never touch `en-US`.** It is the source; locit only writes target locales.
* **Preserve placeholders verbatim** (`{name}`, `{0}`, `#`, ICU plurals). A
  translation that alters a token is wrong — reject it in review.
* **Skip, never fabricate.** If `apply.py` reports a msgid missing, report it;
  do not add an entry (lingui's extractor owns entry creation).
* **Keep the diff minimal.** `apply.py` rewrites only the one `msgstr`; do not
  reformat, re-sort, or re-wrap the catalogs by hand.
* **One writer.** Only `apply.py` writes the `.po` files. Do not hand-edit
  msgstr values from the orchestrator.
