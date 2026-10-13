"""``app_ports.decide`` — the one rule for which port an app's process runs on.

Pure: the process table is a list handed in, so every row of the rule is pinned without a process.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.core import app_ports
from flow_sdk.core.app_ports import Declared, Listener, decide, of_app
from flow_sdk.schema.data_spec.webapp_spec import WebappProxyServing

pytestmark = pytest.mark.timeout(5)

APP = "/work/shop"
START = "npx next dev --port {port}"


def here(port: int, pid: int = 100, cwd: str = APP, command: str = "npx next dev --port 1") -> Listener:
    return Listener(pid, port, "node", cwd, (command,))


def stranger(port: int) -> Listener:
    return Listener(900, port, "java", "/opt/emulator", ("java -jar emulator.jar",))


def rule(declared, mine=(), snapshot=(), *, reserved=(), busy=(), answers=()):
    return decide(
        declared, list(mine), [*mine, *snapshot], reserved=reserved,
        answers=lambda port: port in answers,
        is_open=lambda port: port in busy,
        pick=lambda taken: next(port for port in range(50000, 50100) if port not in taken),
    )


def test_nothing_declared_and_not_running_starts_on_a_free_port():
    answer = rule(None)
    assert (answer.state, answer.port) == ("start", 50000)


def test_nothing_declared_and_running_is_running_where_it_listens():
    answer = rule(None, mine=[here(4310)])
    assert (answer.state, answer.port) == ("running", 4310)


def test_a_required_port_that_is_free_is_the_port():
    assert rule(Declared(3300)) == app_ports.PortAnswer("start", 3300)


def test_a_required_port_the_app_itself_holds_is_running():
    answer = rule(Declared(3300), mine=[here(3300)])
    assert (answer.state, answer.port, answer.holder.pid) == ("running", 3300, 100)


def test_a_required_port_held_by_someone_else_is_a_conflict_that_names_them():
    answer = rule(Declared(3300), snapshot=[stranger(3300)])
    assert answer.state == "conflict"
    assert answer.note == "port 3300 is held by another program: java (pid 900)"


def test_the_app_running_on_another_port_than_the_one_it_requires_is_reported_not_adopted():
    answer = rule(Declared(3300), mine=[here(3001)])
    assert answer.state == "wrong_port" and "port 3001" in answer.note and "port 3300" in answer.note


def test_a_preferred_port_that_is_busy_moves_and_says_so():
    answer = rule(Declared(3300, required=False), snapshot=[stranger(3300)])
    assert (answer.state, answer.port) == ("start", 50000)
    assert answer.note == "port 3300 is busy, so it runs on port 50000"


def test_a_preferred_port_that_is_free_is_used():
    assert rule(Declared(3300, required=False)) == app_ports.PortAnswer("start", 3300)


def test_a_preferred_port_another_app_declares_is_left_to_it():
    answer = rule(Declared(3300, required=False), reserved={3300})
    assert (answer.state, answer.port) == ("start", 50000)


def test_an_app_with_a_preferred_port_is_running_wherever_it_is():
    answer = rule(Declared(3300, required=False), mine=[here(4000)])
    assert (answer.state, answer.port) == ("running", 4000)


def test_the_picker_never_hands_out_a_port_another_app_declares():
    answer = rule(None, reserved={50000, 50001})
    assert answer.port == 50002


def test_a_holder_that_cannot_be_named_is_the_app_only_when_its_health_answers():
    """Another user's process, a container's published port: the process table does not say whose it is."""
    assert rule(Declared(3300), busy={3300}, answers={3300}).state == "running"
    silent = rule(Declared(3300), busy={3300})
    assert silent.state == "conflict" and silent.note == "port 3300 is held by another program"


def test_a_named_stranger_is_never_the_app_even_when_it_answers():
    """The Firestore emulator answers ``Ok`` on 8080: health alone would show it as the Admin backend."""
    assert rule(Declared(8080), snapshot=[stranger(8080)], answers={8080}).state == "conflict"


# ── whose process it is ──────────────────────────────────────────────────────────────────────────


def test_a_listener_is_the_apps_when_its_folder_is_inside_the_apps():
    snapshot = [here(3300, cwd=f"{APP}/frontend"), stranger(8080), here(9000, pid=7, cwd="/work/shop-two")]
    assert [one.port for one in of_app(snapshot, Path(APP), START)] == [3300]


def test_a_page_and_its_api_in_one_folder_are_told_apart_by_how_each_was_started():
    api = "uvicorn main:app --port {port}"
    page = Listener(1, 3300, "node", f"{APP}/frontend", ("next-server", "sh -c npx next dev --port 3300"))
    service = Listener(2, 8090, "python", f"{APP}/backend", ("python uvicorn main:app --port 8090",))
    snapshot = [page, service]
    assert of_app(snapshot, Path(APP), START, [START, api]) == [page]
    assert of_app(snapshot, Path(APP), api, [START, api]) == [service]
    # The page is down: the API beside it is not taken for the page.
    assert of_app([service], Path(APP), START, [START, api]) == []


def test_a_server_started_by_hand_in_the_folder_is_the_apps():
    by_hand = Listener(5, 3300, "node", APP, ("node server.js",))
    assert of_app([by_hand], Path(APP), START) == [by_hand]


# ── the declaration ──────────────────────────────────────────────────────────────────────────────


def test_ports_local_is_read_and_the_older_port_means_required():
    new = WebappProxyServing.model_validate(
        {"type": "proxy", "start_cmd": START, "ports": {"local": {"port": 3300, "required": False}}}
    )
    assert (new.declared_port().port, new.declared_port().required) == (3300, False)
    old = WebappProxyServing.model_validate({"type": "proxy", "start_cmd": START, "port": 3300})
    assert (old.declared_port().port, old.declared_port().required) == (3300, True)
    assert WebappProxyServing.model_validate({"type": "proxy", "start_cmd": START}).declared_port() is None


def test_an_environment_other_than_local_is_refused():
    with pytest.raises(ValueError):
        WebappProxyServing.model_validate({"type": "proxy", "start_cmd": START, "ports": {"cloud": {"port": 80}}})
