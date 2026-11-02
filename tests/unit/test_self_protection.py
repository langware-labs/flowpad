"""FLOWPAD-2112 self-protection: the guard keeps the invariant for our own code.

'may clean up, must not suicide' — a live protected FlowPad process is refused,
everything else (a user's stuck python, a stale/foreign pid) is allowed. Identity
is pid + create_time, never image name.
"""
from __future__ import annotations

import os
import subprocess
import sys

import psutil
import pytest

from flow_sdk.core import self_protection as sp
from flow_sdk.core.self_protection import ProtectedRole
from flow_sdk.instances.procs import terminate_tree


@pytest.fixture
def on(monkeypatch):
    monkeypatch.setenv("FLOWPAD_SELF_PROTECTION", "1")


def _sleeper(secs: int = 30) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, "-c", f"import time;time.sleep({secs})"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
    )


def test_disabled_is_a_noop(monkeypatch):
    monkeypatch.delenv("FLOWPAD_SELF_PROTECTION", raising=False)
    sp.register(ProtectedRole.BACKEND)  # even registered, disabled refuses nothing
    try:
        assert sp.partition_kill([os.getpid(), 999999]) == ([os.getpid(), 999999], [])
    finally:
        sp.release(os.getpid(), "test")


def test_enabled_refuses_protected_allows_others(on):
    sp.register(ProtectedRole.BACKEND)
    try:
        allowed, refused = sp.partition_kill([os.getpid(), 999999])
        assert refused == [os.getpid()]
        assert allowed == [999999]
    finally:
        sp.release(os.getpid(), "test")


def test_release_drops_protection(on):
    sp.register(ProtectedRole.BACKEND)
    assert sp.is_protected(os.getpid())
    sp.release(os.getpid(), "test")
    assert not sp.is_protected(os.getpid())


def test_dead_pid_is_pruned_not_protected(on):
    child = _sleeper()
    sp.register(ProtectedRole.MONITOR, pid=child.pid)
    assert sp.is_protected(child.pid)
    child.kill()
    child.wait()
    # create_time recheck: the pid is no longer that live process
    assert not sp.is_protected(child.pid)


def test_terminate_tree_spares_a_protected_process(on):
    child = _sleeper()
    try:
        sp.register(ProtectedRole.BACKEND, pid=child.pid)
        killed, survivors = terminate_tree([psutil.Process(child.pid)])
        assert killed == []        # never touched
        assert survivors == []
        assert psutil.Process(child.pid).is_running()
    finally:
        sp.release(child.pid, "test")
        child.kill()
        child.wait()


def test_terminate_tree_kills_an_unprotected_process(on):
    child = _sleeper()
    killed, survivors = terminate_tree([psutil.Process(child.pid)])
    assert child.pid in killed
    assert survivors == []
    child.wait()


def test_kill_trees_spares_a_protected_process(on):
    from flow_sdk.core.app_ports import kill_trees
    child = subprocess.Popen(
        [sys.executable, "-c", "import time;time.sleep(30)"],
        start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
    )
    try:
        sp.register(ProtectedRole.BACKEND, pid=child.pid)
        kill_trees([child.pid])   # would killpg the group; the guard must discard it
        assert psutil.Process(child.pid).is_running()
    finally:
        sp.release(child.pid, "test")
        child.kill()
        child.wait()


def test_kill_trees_kills_an_unprotected_process(on):
    from flow_sdk.core.app_ports import kill_trees
    child = subprocess.Popen(
        [sys.executable, "-c", "import time;time.sleep(30)"],
        start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
    )
    kill_trees([child.pid])
    child.wait(timeout=5)
    assert child.poll() is not None   # reaped


def test_authorize_lifecycle_disabled_is_true(monkeypatch):
    monkeypatch.delenv("FLOWPAD_SELF_PROTECTION", raising=False)
    assert sp.authorize_lifecycle([os.getpid()], "stop") is True


def test_authorize_lifecycle_non_worker_releases_and_allows(on, monkeypatch):
    monkeypatch.delenv("FLOWPAD_EXECUTION_SCOPE", raising=False)
    sp.register(ProtectedRole.BACKEND)
    assert sp.is_protected(os.getpid())
    assert sp.authorize_lifecycle([os.getpid()], "restart") is True
    # authorized -> the pid was released, so a downstream guarded kill can proceed
    assert not sp.is_protected(os.getpid())


def test_authorize_lifecycle_worker_is_refused(on, monkeypatch):
    monkeypatch.setenv("FLOWPAD_EXECUTION_SCOPE", '[{"type":"agentic_process","id":"x"}]')
    sp.register(ProtectedRole.BACKEND)
    try:
        assert sp.authorize_lifecycle([os.getpid()], "restart") is False
        # refused -> still protected, so terminate_tree would spare it
        assert sp.is_protected(os.getpid())
    finally:
        sp.release(os.getpid(), "test")
