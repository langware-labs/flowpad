"""Test-runner bridges: live progress for any test command, read off the runner itself.

``flow test run --activity <path> -- <runner cmd…>`` (``flow_sdk/cli/commands/test_cmd.py``)
runs a test command and turns what the runner reports into Activity verbs. The runners
speak to it through one runner-neutral file, so a new runner is one small reporter and
no change here.

The event file (``$FLOW_TEST_EVENTS``) is JSON Lines, appended by the runner's reporter:

* ``{"event": "collected", "n": 12}`` — tests that will run; additive (a runner that
  collects module by module reports each module's share).
* ``{"event": "start", "id": "<test id>"}`` — a test began.
* ``{"event": "result", "id": "<test id>", "outcome": "passed|failed|skipped",
  "message": "<first line of the failure>"}`` — a test ended.

Shipped reporters: :mod:`flow_sdk.testing.pytest_progress` (a pytest plugin) and
``vitest_progress_reporter.mjs`` (a vitest reporter). Both write nothing when
``$FLOW_TEST_EVENTS`` is unset, so a plain run is untouched.
"""

EVENTS_ENV = "FLOW_TEST_EVENTS"
