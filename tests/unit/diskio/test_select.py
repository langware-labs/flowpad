"""``kernel()`` — env beats the preference, and a backend that is not there
fails open to Python with ONE warning for the process."""
from __future__ import annotations

import pytest

import flow_sdk.preferences as preferences
from flow_sdk.diskio import contract, select
from flow_sdk.diskio.python.document_reader import PyDocumentReader
from flow_sdk.diskio.python.tree_walker import PyTreeWalker


@pytest.fixture
def switch(selector):
    """The selector's private state, with the warning counted."""
    monkeypatch = selector
    warnings: list[tuple] = []
    monkeypatch.setattr(select.logger, "warning", lambda *args, **kwargs: warnings.append(args))
    monkeypatch.delenv(select.ENV_DISKIO_BACKEND, raising=False)

    def set_pref(value):
        monkeypatch.setattr(
            preferences, "read_instance_pref",
            lambda key, default: value if key == select.PREF_DISKIO_BACKEND else default,
        )

    set_pref("python")
    return type("Switch", (), {"warnings": warnings, "set_pref": staticmethod(set_pref)})


class _Rust:
    CONTRACT_VERSION = contract.CONTRACT_VERSION


def test_the_test_session_is_pinned_to_python():
    import os

    assert os.environ[select.ENV_DISKIO_BACKEND] == "python"


def test_default_is_python(switch):
    assert select.selected_backend() == "python"
    assert isinstance(select.kernel(contract.TreeWalker), PyTreeWalker)
    assert switch.warnings == []


def test_every_piece_has_a_python_backend(switch):
    for piece in contract.PIECES:
        assert isinstance(select.kernel(piece), piece)


def test_env_beats_the_preference(switch, monkeypatch):
    select.register(contract.TreeWalker, "rust", _Rust)
    switch.set_pref("rust")
    assert isinstance(select.kernel(contract.TreeWalker), _Rust)

    monkeypatch.setenv(select.ENV_DISKIO_BACKEND, "python")
    assert select.selected_backend() == "python"
    assert isinstance(select.kernel(contract.TreeWalker), PyTreeWalker)

    switch.set_pref("python")
    monkeypatch.setenv(select.ENV_DISKIO_BACKEND, "RUST")
    assert isinstance(select.kernel(contract.TreeWalker), _Rust)
    assert switch.warnings == []


def test_the_preference_decides_when_the_env_is_unset(switch):
    select.register(contract.TreeWalker, "rust", _Rust)
    switch.set_pref("rust")
    assert select.selected_backend() == "rust"
    assert isinstance(select.kernel(contract.TreeWalker), _Rust)


def test_absent_rust_fails_open_to_python_with_one_warning(switch, monkeypatch):
    monkeypatch.setenv(select.ENV_DISKIO_BACKEND, "rust")
    assert isinstance(select.kernel(contract.TreeWalker), PyTreeWalker)
    assert isinstance(select.kernel(contract.TreeWalker), PyTreeWalker)
    assert isinstance(select.kernel(contract.DocumentReader), PyDocumentReader)
    assert len(switch.warnings) == 1


def test_unknown_backend_name_fails_open_to_python_with_one_warning(switch, monkeypatch):
    monkeypatch.setenv(select.ENV_DISKIO_BACKEND, "fortran")
    for piece in contract.PIECES:
        assert isinstance(select.kernel(piece), piece)
    assert len(switch.warnings) == 1


def test_a_rust_backend_that_fails_to_load_fails_open(switch, monkeypatch):
    def broken():
        raise ImportError("no extension built")

    select.register(contract.TreeWalker, "rust", broken)
    monkeypatch.setenv(select.ENV_DISKIO_BACKEND, "rust")
    assert isinstance(select.kernel(contract.TreeWalker), PyTreeWalker)
    assert isinstance(select.kernel(contract.TreeWalker), PyTreeWalker)
    assert len(switch.warnings) == 1


def test_a_rust_backend_built_for_another_contract_fails_open(switch, monkeypatch):
    stale = type("Stale", (), {"CONTRACT_VERSION": contract.CONTRACT_VERSION + 1})
    select.register(contract.TreeWalker, "rust", stale)
    monkeypatch.setenv(select.ENV_DISKIO_BACKEND, "rust")
    assert isinstance(select.kernel(contract.TreeWalker), PyTreeWalker)
    assert len(switch.warnings) == 1


def test_a_backend_is_built_once(switch):
    assert select.kernel(contract.TreeWalker) is select.kernel(contract.TreeWalker)


def test_a_class_that_is_not_a_piece_is_refused(switch):
    with pytest.raises(KeyError):
        select.kernel(dict)
