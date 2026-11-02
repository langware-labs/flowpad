"""A ``*_type_info.py`` left behind by an upgrade must not stop the server from booting.

`flow upgrade` on a box left 0.2.231's ``cron_event_type_info.py`` next to 0.2.247; it imports a type
the new release removed, and ``register_all`` raised -- the engine crash-looped five times and locked itself.
A module that is not part of the installed release is skipped; a broken shipped module still fails loudly.
"""
import pytest

from flow_sdk.schema import type_info


def _with_extra_module(monkeypatch, name, shipped):
    real_iter = type_info.pkgutil.iter_modules
    real_import = type_info.importlib.import_module

    def iter_modules(path):
        yield from real_iter(path)
        yield type_info.pkgutil.ModuleInfo(None, name, False)

    def import_module(dotted, *a, **k):
        if dotted.endswith("." + name):
            raise AttributeError("type object 'EntityType' has no attribute 'CRON_EVENT'")
        return real_import(dotted, *a, **k)

    monkeypatch.setattr(type_info.pkgutil, "iter_modules", iter_modules)
    monkeypatch.setattr(type_info.importlib, "import_module", import_module)
    monkeypatch.setattr(type_info, "_shipped_module_names", lambda: shipped)


def test_a_leftover_module_from_an_older_release_is_skipped(monkeypatch):
    _with_extra_module(monkeypatch, "cron_event_type_info", shipped={"task_type_info"})
    type_info.register_all()


def test_a_broken_shipped_module_still_fails(monkeypatch):
    _with_extra_module(monkeypatch, "cron_event_type_info", shipped={"cron_event_type_info"})
    with pytest.raises(RuntimeError, match="cron_event_type_info"):
        type_info.register_all()


def test_without_install_metadata_a_broken_module_still_fails(monkeypatch):
    _with_extra_module(monkeypatch, "cron_event_type_info", shipped=None)
    with pytest.raises(RuntimeError, match="cron_event_type_info"):
        type_info.register_all()
