"""The deployment lock works without ``fcntl`` — Windows has no such module.

``pid_of`` / ``loop_state`` ran on every ``agent_serve`` reconcile and died with
``ModuleNotFoundError: No module named 'fcntl'`` (57 times in one desktop log). On Windows the lock is a byte
lock through ``msvcrt``; here ``msvcrt`` is a stand-in that refuses a second lock on the same file, as the real
one does, and ``fcntl`` is made unimportable so any stray use of it fails the test.
"""
from __future__ import annotations

import os
import sys
import types
import uuid

import pytest

from flow_sdk.builtin import deployment_process

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


class _FakeMsvcrt(types.ModuleType):
    LK_NBLCK = 2
    LK_UNLCK = 0

    def __init__(self):
        super().__init__("msvcrt")
        self.locked: set[int] = set()  # (inode-like) ids of locked byte offsets, keyed by file name

    def locking(self, fd, mode, nbytes):
        key = os.fstat(fd).st_ino
        if mode == self.LK_UNLCK:
            self.locked.discard(key)
            return
        if key in self.locked:
            raise OSError(13, "Permission denied")  # what msvcrt raises for a held lock
        self.locked.add(key)


@pytest.fixture
def windows(monkeypatch, tmp_path):
    fake = _FakeMsvcrt()
    monkeypatch.setitem(sys.modules, "msvcrt", fake)
    monkeypatch.setitem(sys.modules, "fcntl", None)  # `import fcntl` now raises ImportError
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(deployment_process, "_home", lambda: tmp_path)
    monkeypatch.setattr(deployment_process, "_starting", lambda deployment: None)
    return fake


@pytest.fixture
def deployment():
    return types.SimpleNamespace(id=str(uuid.uuid4()), snippet=None, name="Mix (local)", provider_labels={})


def test_hold_pid_of_and_loop_state_never_touch_fcntl(windows, deployment):
    assert deployment_process.pid_of(deployment) is None
    lock = deployment_process.hold(deployment.id)
    assert lock is not None
    try:
        assert deployment_process.pid_of(deployment) == os.getpid()
        assert deployment_process.alive(deployment)
        assert deployment_process.loop_state(deployment) == ("alive", "")
    finally:
        lock.close()


def test_a_second_holder_is_refused(windows, deployment):
    first = deployment_process.hold(deployment.id)
    assert first is not None
    assert deployment_process.hold(deployment.id) is None
    first.close()


def test_probing_does_not_leave_the_lock_taken(windows, deployment):
    lock = deployment_process.hold(deployment.id)
    lock.close()  # the loop exited; the file stays behind
    windows.locked.clear()
    assert deployment_process.pid_of(deployment) is None
    assert windows.locked == set(), "a probe must release what it took"
    assert deployment_process.loop_state(deployment)[0] == "failing"
