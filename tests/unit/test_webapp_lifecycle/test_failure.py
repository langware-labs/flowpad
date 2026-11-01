"""A failure's fingerprint is code's, and two occurrences of one failure share it."""

import pytest

from flow_sdk.core.webapp.failure import make, normalize, of_page
from flow_sdk.schema.data_spec.webapp_lifecycle_spec import FailureCode, FailurePhase


@pytest.mark.parametrize("a, b", [
    ("TypeError: x at http://localhost:61510/src/main.tsx?t=1730 :12:4",
     "TypeError: x at http://localhost:52001/src/main.tsx?t=99 :12:4"),
    ("failed to load http://127.0.0.1:61510/assets/index.4f3a9c2b1e.js",
     "failed to load http://127.0.0.1:50000/assets/index.99aa88bb77.js"),
    ("`npm ci` failed (exit 1) — log: /Users/x/.flow/logs/a.log", "`npm ci` failed (exit 137) — log: /tmp/b.log"),
    ("server pid 4242 died on port 8300", "server pid 17 died on port 8301"),
    ("run 1f0c2a1e-9b7d-4c3e-8a51-2d4e6f8a9b10 broke at 2026-10-31T02:00:01Z",
     "run 2f0c2a1e-9b7d-4c3e-8a51-2d4e6f8a9b11 broke at 2026-11-01T09:12:44Z"),
])
def test_what_varies_between_two_occurrences_does_not_change_the_fingerprint(a, b):
    assert of_page(a).fingerprint == of_page(b).fingerprint


def test_a_different_error_or_phase_is_a_different_fingerprint():
    assert of_page("TypeError: a").fingerprint != of_page("TypeError: b").fingerprint
    start = make(FailurePhase.START, FailureCode.EXITED, "it died")
    health = make(FailurePhase.HEALTH, FailureCode.EXITED, "it died")
    assert start.fingerprint != health.fingerprint


def test_the_app_folder_reads_as_app():
    assert normalize("cannot read /Users/me/proj/web/src/a.ts", folder="/Users/me/proj/web") == "cannot read <app>/src/a.ts"


def test_a_relay_not_answering_is_its_own_typed_failure():
    failure = of_page("not_answering", "relay")
    assert failure.code is FailureCode.NOT_ANSWERING and failure.phase is FailurePhase.HEALTH
