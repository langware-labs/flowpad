# Test integrity — did a test edit stop guarding what it guarded?

A test changed so it passes can quietly stop protecting the behavior it was
written for: the developer makes it green and loses the coverage. This lens
reads every **modified or deleted** test in the diff and asks one question:
*after the edit, would this test still fail if the code it protects broke?*

New test files are out of scope here (code-review covers them); this lens is
about tests that existed before the branch.

## 1. List the edited tests

```bash
git diff "$BASE"...HEAD --name-only --diff-filter=MD -- 'tests/**' 'ui/tests/**' '**/tests/**'
git diff "$BASE"...HEAD -- <each file>      # read the before AND after of every changed test
```

For each changed test function, write down in one line **what it protected
before** (from its name, docstring, and old assertions). That line is the yardstick.

## 2. Red flags — check each changed test against these

| Red flag | Why it can hollow the test out |
| --- | --- |
| An assertion removed, loosened, or swapped for a weaker one (`==` → `in`, exact value → `is not None`, `timed_out` → `not ok`) | It may now pass for the wrong reason |
| An expected value changed | Fine only if the **product** change in the same diff deliberately changed that behavior. Otherwise the test was made to agree with a bug |
| A new `skip` / `skipif` / `xfail` / early `return` | It may skip where it used to run — check it still runs on macOS and CI |
| A new mock / monkeypatch / stub of the code under test (or of something it calls) | It may now test the mock. Narrow, scenario-level mocks are fine; replacing the thing under test is not |
| The test now calls internals instead of the public entry point it used to call | The entry point's own logic (timeout, error mapping, cleanup) is no longer covered |
| The expectation is computed with the same logic as the product (`expected = <copy of the implementation>`) | A tautology: it can't fail when that logic is wrong |
| A raised timeout, new retry, `flaky`, or wider polling budget | Banned outright by CLAUDE.md — a **blocker** with no further analysis |
| A deleted test, with no replacement covering the same behavior | Lost coverage |

## 3. Verdict per changed test

* **Still guards** — the yardstick behavior would still fail the test if broken. One line in the report.
* **Weakened** — name exactly what is no longer covered and a concrete break
  that would now slip through ("if `run_snippet` stopped keeping output on
  timeout, this test would still pass"). Severity **should fix**; **blocker** if
  the lost coverage is the test's main purpose, or if no other test covers it.
* **Unsure** — when it depends on the environment (a skip, a host-specific
  path), say where it runs and where it doesn't. Mark PLAUSIBLE.

Before marking a test Weakened, check whether a sibling test still covers the
lost behavior; if one does, cite it and downgrade to a nit.

When in doubt, prove it: break the product code locally for that one behavior
(in a scratch copy, never committed), run only that test, and confirm it goes red.
A test that stays green against the broken code is Weakened, CONFIRMED.
