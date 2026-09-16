"""The data source matrix, REST surface: every shipped data source × every verb.

REST is the seam the ``flow source`` CLI, the TS SDK's ``DataDriver`` and the Data Sources screen
share; the scenario and each source's case live in ``tests/api/_source_matrix.py`` and the source's
own ``tests/matrix.py``.
"""
from __future__ import annotations

import pytest

from flow_sdk.ingest.driver_registry import SHIPPED_ROOT
from tests.api._source_matrix import NAMES, RestDriver, run_case

pytestmark = pytest.mark.asyncio


def test_every_shipped_source_has_a_matrix_case():
    missing = [name for name in NAMES if not (SHIPPED_ROOT / name / "tests" / "matrix.py").is_file()]
    assert not missing, f"data sources with no tests/matrix.py case: {missing}"


@pytest.mark.parametrize("name", NAMES)
async def test_the_source_works_end_to_end(name, client, monkeypatch, tmp_path):
    await run_case(name, RestDriver(client), client, monkeypatch, tmp_path)
