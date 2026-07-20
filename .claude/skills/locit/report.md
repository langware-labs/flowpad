# Locit report shape

After `apply.py` has written the catalogs, present the run in two parts. Show
the summary in chat; save the detailed report to
`<scratchpad>/locit_report.md` and offer it (it can be long).

## Summary (in chat)

* One line of scope: locales run, git ref, whether `--limit` was applied.
* A per-locale table:

  | locale | translated | stale refreshed | skipped | not found |
  | ------ | ---------- | --------------- | ------- | --------- |
  | he     | 42         | 3               | 1       | 0         |

  * **translated** — `reason: untranslated` items written.
  * **stale refreshed** — `reason: stale` items rewritten.
  * **skipped** — `placeholders_ok: false` (never written).
  * **not found** — `apply.py` `MISSING` (msgid absent in that catalog).
* Confirm the git diff on `ui/src/locales/**` touches only `msgstr` lines, and
  that `en-US` is untouched.

## Detailed report (`locit_report.md`)

One section per translated string:

```
### <source_text>   [locale · reason]
refs: <#: file(s)>
meaning: <researcher's meaning/context summary>
candidates:
  1. …            (the 10 researched options)
  …
chosen: <final translation>
why: <reviewer rationale>
```

List skipped / not-found strings at the end with their reason so nothing is
silently dropped.
