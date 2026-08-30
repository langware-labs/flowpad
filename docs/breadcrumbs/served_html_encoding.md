---
id: 0cdcfaab-f5c6-42b4-99b8-425317c03a71
title: Served app HTML must be read as UTF-8
tags:
- breadcrumb.test.served_html_encoding.rules
description: App HTML is UTF-8 by definition; serving must never consult the host
  locale. A text-mode read without encoding= decodes as cp1252 on Windows — mojibake
  on every non-ASCII page, and a 500 only when a byte lands on one of five undefined
  slots.
---

# Served app HTML must be read as UTF-8

> Ground truth. Proven by RCA on 2026-08-17 (FLOWPAD-1991), toggled both
> directions against a live instance. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.served_html_encoding.rules
sites:
  - rel_path: "tests/unit/test_serve_static_encoding.py"
    line: 81
    note: "FAILING? read this tag's rules before editing — a UTF-8 CI cannot see this bug, do not relax the assertion"
  - rel_path: "tests/api/test_micro_app_view.py"
    line: 58
    note: "FAILING? read this tag's rules before editing — a 200 is not a pass, assert the served text matches disk"
```

## Expected behavior

`GET /api/v1/graph/micro_app/<id>/view` returns the app's `index.html` **byte-
faithfully**, whatever codepage the host happens to have. A UTF-8 document with
Hebrew, CJK, emoji or accented Latin arrives at the browser intact.

"Intact" is the only definition used here, and it is stronger than "no error":
a 200 carrying mojibake is a failure of this contract, not a partial success.

## Internals

Python text I/O with no `encoding=` falls back to
`locale.getpreferredencoding()`. That is **cp1252 on a Windows host** and never
UTF-8 — the file's encoding is not consulted, and neither is its `<meta charset>`.

* `flow_sdk/builtin/faas/serve_static.py:159` — `serve_app_bytes`, the one
  implementation of "serve a file out of an app folder". The HTML branch reads
  in **text** mode because it rewrites the document (base tag + API origin
  injection), so it must state `encoding="utf-8"`:

  ```python
  async with await anyio.open_file(str(requested_file), "r", encoding="utf-8") as f:
  ```

* `flow_sdk/builtin/faas/serve_static.py:109` — `_file_iterator`, the asset
  branch, reads `"rb"`. Bytes are never decoded, so assets were never affected.
  This asymmetry is why "images work, the page is broken" is the expected
  presentation of the bug, not a clue pointing elsewhere.
* `flow_sdk/builtin/faas/micro_app.py:164` — `MicroApp.view`, the only caller on
  the console API path; `view_external_domain` (`:171`) is the custom-domain
  twin. Both reach the same read.
* `flow_sdk/utils/concurrency.py:89` — the correct shape to copy: `encoding` is a
  parameter threaded through to `anyio.open_file`.

## Invariants

1. **Never open a served document in text mode without `encoding=`.** The app's
   bytes are UTF-8; the host's locale is an accident of the machine and must not
   enter the decision.
2. **A 200 is not a pass.** Any assertion about serving must compare the served
   text to the bytes on disk. Asserting only on status code makes the silent
   half of this bug invisible forever.
3. **Binary stays binary.** The asset branch must keep `"rb"` — do not
   "unify" the two branches onto one text-mode read.
4. **Test fixtures must state their own encoding.** A fixture written with a
   bare `write_text(...)` is stored in the host codepage, so the test then reads
   back exactly what it wrote and passes on a broken implementation. Always
   `write_text(..., encoding="utf-8")`.
5. **`errors="replace"` is not a fix.** It converts a crash into permanent
   silent corruption, which is strictly worse — the data is destroyed and
   nothing reports it.

## Failure modes

* **A UTF-8 CI cannot see this.** All three workflows run `ubuntu-latest`, where
  `getpreferredencoding()` is UTF-8 and *any* test of this contract passes
  whether or not the defect is present. A green pipeline is no evidence here.
  The durable guard must force a non-UTF-8 ambient encoding for real
  (`PYTHONUTF8=0`, plus `LC_ALL=C` off Windows) — see the bound tests.
* **Non-ASCII must not cross a process boundary in a test that forces a
  non-UTF-8 ambient.** The unit test's first version passed the Hebrew needle to
  its child as `argv`. On POSIX, `argv` is decoded with the filesystem encoding
  — which under `LC_ALL=C` + `PYTHONUTF8=0` is ASCII+surrogateescape, exactly
  the condition the test exists to create. Ubuntu CI reported `STATUS:200`
  (the server had served the page perfectly) with `INTACT:False`, i.e. a *green
  server and a red test*, for a reason that had nothing to do with the contract.
  Derive expected values inside the child, from the file, with an explicit
  `encoding=`; the same applies to env vars, filenames and stdin.
* **The proof lever is not the fix.** `PYTHONUTF8=1` toggles the symptom, which
  is what made it a clean on/off switch, but it is a process-level setting and
  does nothing for anyone importing `flow_sdk` into their own interpreter.
