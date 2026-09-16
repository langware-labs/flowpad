"""A hash written by an older build must not read as config drift.

``restart_required`` compared the live snapshot's hash against the STORED
``last_started_hash``. But the hashed payload is normalized first, and that
normalization changed: 929f9b0e9 began stripping
``TRANSPORT_DERIVED_WORKER_FIELDS`` (``ephemeral``, ``json_stream``). A row
whose hash was written before that build hashed those fields IN, so it can
never equal today's hash of the identical config.

The user saw the restart glow on a process nobody had touched — while
``restart-info`` reported ``changed=[]``, because ``_diff_snapshot_fields``
compares payloads and ``save()`` compared hashes. Two comparators, two
answers.

The fix compares against a hash recomputed from ``last_started_snapshot`` (the
payload persisted beside the hash), which is what today's algorithm would have
produced for that same launch.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(5)


def _process_with_snapshot() -> AgenticProcess:
    proc = AgenticProcess(name="restart-skew")
    payload = proc._restart_snapshot_payload()
    proc.last_started_snapshot = payload
    proc.last_started_hash = proc._restart_snapshot(payload)
    return proc


def test_reference_hash_matches_the_stored_one_when_the_build_agrees():
    """No skew: a hash this build wrote is already the reference."""
    proc = _process_with_snapshot()
    assert proc._restart_reference_hash() == proc.last_started_hash


def test_reference_hash_ignores_a_legacy_stored_hash():
    """The regression: a stale stored hash must not become the comparison base.

    Simulates a pre-929f9b0e9 row by corrupting only the STORED hash while
    leaving the persisted snapshot — the launch inputs — untouched. That is
    exactly the shape of a row hashed under the old normalization.
    """
    proc = _process_with_snapshot()
    todays_hash = proc.last_started_hash
    proc.last_started_hash = "legacy-hash-from-an-older-build"

    reference = proc._restart_reference_hash()

    assert reference == todays_hash, "the reference must come from the snapshot, not the stored hash"
    assert reference != proc.last_started_hash

    # And the live config, unchanged, must compare EQUAL to that reference —
    # i.e. no phantom restart_required.
    assert proc._restart_snapshot() == reference


def test_reference_hash_falls_back_when_there_is_no_snapshot():
    """Rows predating last_started_snapshot keep the old behaviour."""
    proc = AgenticProcess(name="restart-skew-nosnap")
    proc.last_started_snapshot = None
    proc.last_started_hash = "whatever-was-stored"
    assert proc._restart_reference_hash() == "whatever-was-stored"


def test_genuine_drift_is_still_detected():
    """The guard must not swallow a real config change."""
    proc = _process_with_snapshot()
    reference = proc._restart_reference_hash()

    proc.cli_config = {**(proc.cli_config or {}), "env_vars": {"CHANGED": "yes"}}

    assert proc._restart_snapshot() != reference, "a real config change must still read as drift"


def test_the_symptom_itself_comparing_against_the_stored_hash_lies():
    """Stated without the new helper, so it describes the BUG, not the fix.

    This is what ``save()`` used to do. The config is untouched, yet the
    comparison reports drift purely because the stored hash came from a build
    with a different normalization — the phantom restart glow.
    """
    proc = _process_with_snapshot()
    proc.last_started_hash = "legacy-hash-from-an-older-build"

    drift_against_stored = proc._restart_snapshot() != proc.last_started_hash
    drift_against_snapshot = proc._restart_snapshot() != proc._restart_snapshot(proc.last_started_snapshot)

    assert drift_against_stored is True, "the old comparison base reports drift on unchanged config"
    assert drift_against_snapshot is False, "the snapshot-derived base correctly reports none"


def test_reference_hash_is_pure():
    """It computes; save() decides whether to write back."""
    proc = _process_with_snapshot()
    proc.last_started_hash = "legacy-hash-from-an-older-build"
    proc._restart_reference_hash()
    assert proc.last_started_hash == "legacy-hash-from-an-older-build"
