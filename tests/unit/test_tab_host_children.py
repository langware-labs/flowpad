"""Backend half of the host-tab child contract (tests/fixtures/tab_host_children.json).

The frontend twin is ui/tests/unit/tab-host-children.test.ts; together they keep
`_HOST_CHILD_RULES` (tab.py) and `navigation/tab-hosts.ts` from drifting apart.
"""

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.tab import _HOST_CHILD_RULES, _view_hosts_tabs

FIXTURE = json.loads((Path(__file__).parents[1] / "fixtures" / "tab_host_children.json").read_text())
CASES = [(host, case) for host, cases in FIXTURE["hosts"].items() for case in cases]


def test_every_backend_host_is_in_the_fixture():
    assert set(_HOST_CHILD_RULES) == set(FIXTURE["hosts"])


@pytest.mark.parametrize(("host", "case"), CASES, ids=[f"{h}:{c['name']}" for h, c in CASES])
def test_host_accepts_the_stored_pointer(host, case):
    assert _HOST_CHILD_RULES[host](case["stored"]) is case["backend"]


def test_a_host_is_never_a_child():
    for host in _HOST_CHILD_RULES:
        assert _view_hosts_tabs(host)
