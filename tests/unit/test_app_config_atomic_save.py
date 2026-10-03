"""A config write never shows a reader a half-written file.

``is_logged_in()`` reads the user record out of the instance config; while any
other key was being saved, the in-place write let a concurrent read see an empty
file — "logged out" — and ``handle_add_message`` dropped a shared conversation's
message instead of sending it to the hub (hub test asset_share_index_matrix).
"""
from __future__ import annotations

import threading
import time

from flow_sdk.cli import app_config
from flow_sdk.cli.auth.hub_login import is_logged_in


def test_a_reader_never_sees_the_user_vanish_while_another_key_is_saved(tmp_path, monkeypatch):
    monkeypatch.setattr(app_config, "_config_file_path", lambda: tmp_path / "config.json")
    app_config.set_user({"id": "u1", "email": "a@b.c", "pad": "x" * 4000})
    stop = threading.Event()

    def writer() -> None:
        i = 0
        while not stop.is_set():
            app_config.set_config("unrelated_key", i)
            i += 1

    thread = threading.Thread(target=writer)
    thread.start()
    misses = reads = 0
    try:
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            reads += 1
            misses += not is_logged_in()
    finally:
        stop.set()
        thread.join()
    assert reads > 100
    assert misses == 0, f"user record vanished in {misses}/{reads} reads during unrelated writes"
    assert not list(tmp_path.glob(".config.json.*.tmp")), "temp files left behind"
