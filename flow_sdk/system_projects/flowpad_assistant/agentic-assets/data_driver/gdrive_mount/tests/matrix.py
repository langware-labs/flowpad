"""The ``gdrive_mount`` source's case in the data source matrix: My Drive as a local folder
(``mount_root``) with three files, Drive for desktop reported installed."""
from __future__ import annotations

import sys
from contextlib import contextmanager

from flow_sdk.builtin.data_driver import DataDriver


@contextmanager
def case(monkeypatch, tmp_path):
    source = sys.modules[DataDriver.loaded("gdrive_mount").cls.__module__]
    monkeypatch.setattr(source, "installed", lambda: True)
    my_drive = tmp_path / "My Drive"
    (my_drive / "GTM" / "sub").mkdir(parents=True)
    for rel, body in (("a.md", "alpha"), ("b.md", "bravo"), ("sub/c.md", "charlie")):
        (my_drive / "GTM" / rel).write_text(body)
    yield {"config": {"path": "GTM", "mount_root": str(my_drive)}, "fields": {"reflect": "none"}}
