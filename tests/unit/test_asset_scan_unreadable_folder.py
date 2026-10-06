"""One folder an asset scan cannot read is skipped, not the whole scan.

The regression (Windows): the shipped smart-navigator dataset nests data_specs past MAX_PATH, ``listdir``
raised there, and the error aborted the whole system-assets index -- no data driver loaded, so "Add a data
source" offered nothing ("No installed provider can carry a channel").
"""
from __future__ import annotations

import os

import pytest

from flow_sdk.assets.layout import Folder
from flow_sdk.assets.scanning import directory_candidates

pytestmark = pytest.mark.timeout(5)  # do not increase without approval


def test_a_readable_folder_lists_its_entries(tmp_path):
    (tmp_path / "b").mkdir()
    (tmp_path / "a").mkdir()
    assert directory_candidates(tmp_path, Folder(), recursive=False) == [tmp_path / "a", tmp_path / "b"]


def test_a_folder_that_cannot_be_read_is_skipped(tmp_path, monkeypatch, caplog):
    def unreadable(path):
        raise FileNotFoundError(3, "The system cannot find the path specified", str(path))

    monkeypatch.setattr(os, "listdir", unreadable)
    assert directory_candidates(tmp_path, Folder(), recursive=False) == []
    assert "cannot read" in caplog.text
