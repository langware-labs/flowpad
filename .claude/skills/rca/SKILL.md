---
id: ccaf9012-abc8-4413-9c81-38d5d31018d3
name: rca
description: Root Cause Analyzer — prove the real cause of a failure by finding its
tags: ''
eval: 'false'
version: 139
---

# RCA — Root Cause Analyzer

Find why something fails, **prove it**, and stop. No guessing, no estimating, no
"this should fix it." A cause you cannot toggle is a hypothesis, not a root cause.

## Modes (from the skill arg)

* no arg / `default` → **RCA mode**

* `test` → **Test mode** — assumes a root cause is already proven this session. If none is,
  run RCA mode first, or ask the user to point at the known cause.

## RCA mode — find the on/off switch

1. **No fluff.** Every claim is backed by observed evidence — error text, stack trace, a log
   line, or a reproduced run. If you haven't seen it, you don't know it.
2. **Attribute evidence to a path only after proving that path RAN.** A 404, a log line, a
   failed query is evidence that *something* did it — never evidence that your suspect did it.
   Two call sites can produce a byte-identical symptom, so reading a plausible one and declaring
   it the source is a hallucinated scenario: a chain that explains the evidence without ever
   having executed. Before a code path enters your causal chain, make it *say so* — a temporary
   `console.log`/print at the suspect line, a breakpoint, a stack trace, a counter. If it doesn't
   log, it didn't run, and everything you inferred downstream of it is fiction. Instrumenting
   needs no hypothesis and costs one run, so do it BEFORE theorizing, not after a fix disappoints.
   Remove the probes when done.
3. **Reproduce first.** Get the failure to happen on demand before theorizing.
4. **Trace backward.** From where the symptom surfaces, follow the wrong state / invalid data
   *upstream* to the original trigger. Do not stop at the layer where the error is thrown.
5. **Fastest credible path to cause** — but the cause is not accepted until proven.
6. **Proof = the on/off switch.** Name the single lever — a flag, variable, code line, config,
   input, or memory — such that:

   * changing it makes the bug **disappear**, and

   * reverting it makes the bug **come back**.
     Demonstrate *both* directions. One direction is a coincidence; both is a root cause.
7. **Report inline and stop.** No file or memory artifact. The report is exactly two parts,
   in this order — nothing else:

   1. **An ASCII flow chart** tracing the logical bug flow top-to-bottom, from the SYMPTOM down
      through each upstream link to the EXPECTED FIX. One node per causal step; `│ ▼` connectors.
      Pin the proven on/off switch into the chart (the code line / flag, and the before/after
      observation that toggled it — e.g. `[proven: force=true → row created → search hits]`).
   2. **One line** stating the core of the issue *logically* — cause → effect in plain terms,
      e.g. "the query fails because the process is missing a flag" or "server restarted, so the
      cached PTY process id is stale." Not a restatement of the symptom; the mechanism.

   Template:

   ```
   SYMPTOM
     <what the user observes>
         │
         ▼
     <next upstream link>
         │
         ▼
     <the proven switch>   [proven: <toggle> → bug gone / reverting → bug back]
         │
         ▼
     EXPECTED FIX
       <the change that removes the cause>
   ```

   **Core (one-liner):** \<logical cause → effect>.

**Never mask the symptom.** A slow / locked / flaky / 5xx failure *is* the bug to root-cause.
Do not raise or add any timeout, retry, sleep, backoff, or poll budget to ride past it — that
hides the bug instead of finding its switch.

## Test mode — capture the bug

**Run autonomously. Do NOT ask the user anything — no interface approval, no "is this OK?",
no clarifying questions, no progress check-ins.** Just write the test, run it, and come back
**only** when you have hit one of the three terminal outcomes below. The user invoked test mode
*because* a root cause is already proven this session — act on it.

1. **Precondition:** a proven root cause exists this session. If none is proven, that is the
   `IMPOSSIBLE` outcome (see below) — return immediately; do not start an RCA and do not ask the
   user to point at one.
2. **Write it at the narrowest layer that still reproduces** — prefer unit over API over anything
   heavier. The test must **fail in exactly the way the bug manifests** (same assertion / error)
   and pass once the fix flips the proven switch. "Still reproduces" is the load-bearing half and
   the one that gets assumed: **the test must ENTER through the same call path the real scenario
   enters.** Calling the suspect function directly, when the app reaches it through a chain
   (route loader → lifecycle wrapper → adapter → your function), tests your hypothesis rather
   than the bug — and it passes happily while the real path dies two frames upstream and never
   arrives. So name the real entry point first (from the instrumented run — RCA rule 2), then
   pick the narrowest seam ON that path. A seam the product never calls is not a narrow test, it
   is a different test.
   Corollary for multi-layer coverage: two tests only count as two if they enter DIFFERENTLY.
   A "unit + integration" pair that both call the same hand-built entry point is one test twice,
   and it will confirm the same wrong assumption twice — do not report it as independent coverage.
3. **Use** **`funit`** **for the mechanics, but its interaction gates do NOT apply here** — this
   mode overrides funit's "TDD-approve the interface" and "flag >1s" steps. Pick the interface
   yourself and write it. Still honor funit's *craft* rules (fast pytest / vitest, real entities,
   minimal elegant interface).
4. **Reproduce the real failure — NEVER mock without explicit user approval, every time.** The
   test must trigger the bug through the *real* mechanism, not a stand-in for it. No
   `monkeypatch`/`mock`/stub/fake of the component under test, no hand-forcing the broken state
   (e.g. deleting the row the bug is supposed to strand), no injected exception standing in for a
   real fault. If the failure only happens on an abnormal event (crash, restart, commit-failure,
   disconnect, OOM), reproduce *that event for real* — SIGKILL a real subprocess mid-operation,
   make the real resource fail (read-only fs, closed connection), drive the real I/O/process
   lifecycle. A mock proves your model of the bug, not the bug. If a faithful reproduction is
   genuinely impossible without mocking, that is the `IMPOSSIBLE` outcome — STOP and ask the user
   for approval to mock before writing it; do not decide unilaterally.
5. **Run the test and confirm it fails for the right reason** (the bug's assertion/error, not an
   import/setup error). Do not edit timeouts/retries/sleeps to make anything pass — that is the
   banned symptom-masking move. "Right reason" means the test and the real scenario fail from the
   **same cause**, not merely that both are red — a test can fail for a reason you invented and
   look identical from the outside. Cross-check them: the real run's own evidence (its instrumented
   line, its error text) must appear in the test's failure too. When you can only assert on a proxy
   for the symptom (a function's return value, a thrown redirect) rather than the symptom itself
   (what the user sees), say so in the `FOUND` report — a proxy assertion is exactly where a green
   test and a broken product diverge.
6. **Never bind a test to a backend via the** **`__FLOWPAD_API_URL__`** **runtime override.** That global
   re-points a hand-rolled SDK realm and skips the client bootstrap the product actually uses.
   A test that needs a backend is an OFFICIAL api-tier test with the proper client:
   `apiTestSetup()` + `ConnectionManager.getInstance()`, backend resolved by the tier's own
   config — target a disposable instance by running the tier with `FLOW_INSTANCE=<name>`
   (e.g. `FLOW_INSTANCE=dev-1 vitest --project api`), never by overriding the URL in the test.

**Return with exactly one terminal outcome — and nothing in between:**

* **`FOUND`** — a failing test exists that reproduces the bug for the right reason. Report its
  path, the test name, and the failing assertion/error output. (Do not implement the fix unless
  separately asked.)

* **`NOT FOUND`** — you wrote a faithful test at the narrowest reproducing layer and it
  **passes**, i.e. the code does not actually exhibit the bug there. Report the test, that it
  passes, and what that implies (the proven switch may not manifest at this layer, or the bug is
  elsewhere).

* **`IMPOSSIBLE`** — no proven root cause exists this session, or the bug genuinely cannot be
  captured without a slower/heavier (e.g. e2e) harness than is warranted. Report why, and what
  layer it *would* take.

## Close the loop — confirm against the REAL symptom (mandatory)

A green test is **necessary, not sufficient.** A test reproduces a *layer*; it can pass while
the original failure still happens, because the switch you toggled was a proxy or only one of
several causes. So before claiming a root cause is fixed, you must drive the **fix** through the
**original scenario** — not just the test — and toggle it **both directions there**:

1. Apply the fix. Confirm the test goes green.
2. **Reproduce the original failure with the fix in place** (same surface the user reported —
   the real page / command / flow, not the test). It must be **gone**.
3. **Revert the fix** and reproduce again. The failure must **come back**.
   Same backend / same state for both directions — change only the one lever, so instance state
   or caches can't masquerade as the switch.

Use a backend-recorded ground-truth signal where you can (a git commit landing, a row written,
a log line) rather than a UI/idle heuristic — screenshot "still loading" / network-idle waits
lie when the app holds persistent connections. Verify the surface actually reached the failing
code (e.g. the editor really mounted) before trusting an absence-of-symptom as success.

### RCA rejection mode

If step 2 fails — **test green but the original scenario still reproduces** — you have NOT found
the root cause. Declare **RCA rejection** and:

1. **Undo your code changes** (the fix, and any source seams/exports added only to enable the
   test). Leave the tree as you found it.
2. **Restart RCA mode from scratch**, carrying the rejection as evidence: the proven-toggled
   switch was real but *not the cause of this symptom*, so the true cause is upstream of — or
   parallel to — what you toggled. Re-reproduce and trace again from there. Do not re-propose the
   rejected switch.
