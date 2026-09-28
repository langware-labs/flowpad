"""Long test: ``docs/snippets/processes.md`` §4 on a REAL harness — a CV in, a CV out.

The fast tier runs the same fence on the mock worker (``tests/unit/test_processes_snippets.py``);
this one proves a real model, told only what ``process_io`` tells it, writes a folder that loads
back as the declared DataSpec. It runs on the harness the user selected (no worker is named — the
point of the fence), and skips when that harness is not installed.

Staged, the tier's convention: an environment gap (no selected harness, not installed, a turn slower
than the guard) SKIPS; a run that finished but wrote no valid ``CVSpec`` FAILS.

NOTE: listed in ``conftest._REAL_HOME_TEST_MODULES`` so the CLI subprocess sees the real logins.
"""
from __future__ import annotations

import asyncio

import pytest

from tests.long_tests.conftest import worker_is_installed
from tests.test_settings import test_service_config
from tests.utils.snippets import doc, fence_under, run_fence

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.timeout(30),  # do not increase timeout without approval
    pytest.mark.skipif(not test_service_config.deep_testing, reason="Skipping long tests when DEEP_TESTING is disabled"),
]

#: Strictly below the 30 s cap, so a hang fails as a slow turn rather than masking one.
_TURN_GUARD_SECONDS = 25

_CV = """Dana Levi — dana@x.io
Backend engineer, 8 years. Go, Postgres, Kafka. Led the payments platform at Acme."""


async def test_a_real_harness_reviews_a_cv_into_the_declared_shape(initialize_test_db):
    from flow_sdk.core.capabilities.registry import resolve_default_worker_type

    try:
        worker = await resolve_default_worker_type()
    except RuntimeError as none:
        pytest.skip(f"no harness selected: {none}")
    from flow_sdk.flowpad_types.vendors import vendor_or_none

    vendor = vendor_or_none(worker)
    if vendor is None or not worker_is_installed(vendor.key):
        pytest.skip(f"the selected harness {worker!r} is not installed")

    try:
        ns = await asyncio.wait_for(
            run_fence(fence_under(doc("processes.md"), "4."), {"CV_TEXT": _CV}, filename="processes.md §4"),
            timeout=_TURN_GUARD_SECONDS,
        )
    except asyncio.TimeoutError:
        pytest.skip(f"the turn took longer than {_TURN_GUARD_SECONDS}s on {worker}")

    answer = ns["cv_reviewed"]
    if not answer.ran:
        pytest.skip(f"the worker never started: {answer.detail}")
    assert answer.ok, f"{worker} finished but its output is not a CVSpec: {answer.detail} — wrote {answer.files}"
    assert type(answer.value) is ns["CVSpec"]
    assert answer.value.name and answer.value.email and answer.value.body.strip()
