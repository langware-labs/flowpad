---
id: ccaf9012-abc8-4413-9c81-38d5d31018d3
name: rca
description: Root Cause Analyzer — prove the real cause of a failure by finding its on/off switch, then optionally capture it as a fast failing test
tags:
- debugging
- rca
- testing
---

# RCA — Root Cause Analyzer

Find why something fails, **prove it**, and stop. No guessing, no estimating, no
"this should fix it." A cause you cannot toggle is a hypothesis, not a root cause.

## Modes (from the skill arg)

- no arg / `default` → **RCA mode**
- `test` → **Test mode** — assumes a root cause is already proven this session. If none is,
  run RCA mode first, or ask the user to point at the known cause.

## RCA mode — find the on/off switch

1. **No fluff.** Every claim is backed by observed evidence — error text, stack trace, a log
   line, or a reproduced run. If you haven't seen it, you don't know it.
2. **Reproduce first.** Get the failure to happen on demand before theorizing.
3. **Trace backward.** From where the symptom surfaces, follow the wrong state / invalid data
   *upstream* to the original trigger. Do not stop at the layer where the error is thrown.
4. **Fastest credible path to cause** — but the cause is not accepted until proven.
5. **Proof = the on/off switch.** Name the single lever — a flag, variable, code line, config,
   input, or memory — such that:
   - changing it makes the bug **disappear**, and
   - reverting it makes the bug **come back**.
   Demonstrate *both* directions. One direction is a coincidence; both is a root cause.
6. **Report inline and stop.** State: the symptom, the proven root cause, the exact switch, and
   the before/after observation for each direction. No file or memory artifact.

**Never mask the symptom.** A slow / locked / flaky / 5xx failure *is* the bug to root-cause.
Do not raise or add any timeout, retry, sleep, backoff, or poll budget to ride past it — that
hides the bug instead of finding its switch.

## Test mode — capture the bug

1. **Precondition:** a proven root cause exists. The test must **fail in exactly the way the bug
   manifests** (same assertion / error), and pass once the fix flips the switch.
2. **Delegate the test mechanics to the `funit` skill.** Defer to its rules — fast pytest
   (Entity / Record / pure function) or python API; vitest unit-only or vitest API for frontend;
   no mocks without approval; flag any test over 1s and get approval; TDD-approve the interface
   before writing.
3. **rca's only addition:** the test must reproduce *this specific failure*, written at the
   **narrowest layer that still reproduces it** — prefer unit over API over anything heavier.
   If the bug genuinely needs a slower or more complex (e.g. e2e) test, **alert the user and get
   explicit approval before writing it.**
