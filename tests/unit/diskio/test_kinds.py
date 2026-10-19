"""Every ``diskio.*`` kind resolves to its class — never to ``Any``.

Registration is import-time and forgetting it fails silently: an unreachable
kind resolves to ``Any`` and a field typed by it validates anything.
"""
from __future__ import annotations

import inspect
from typing import Any

import pytest

from flow_sdk.diskio import contract
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec import DataSpec, diskio_spec
from flow_sdk.schema.data_spec._kinds import register_builtin_kinds, resolve_kind


@pytest.mark.parametrize("value", contract.VALUES, ids=lambda v: v.spec_kind)
def test_kind_resolves_to_its_class(value):
    assert value.spec_kind.startswith("diskio.")
    assert SchemaRegistry.kind_type(value.spec_kind) is value
    resolved = resolve_kind(value.spec_kind)
    assert resolved is not Any and resolved is value


@pytest.mark.parametrize("value", contract.VALUES, ids=lambda v: v.spec_kind)
def test_value_is_frozen_and_refuses_unknown_keys(value):
    assert value.model_config["frozen"] is True
    assert value.model_config["extra"] == "forbid"


def test_every_value_class_of_the_contract_is_listed():
    declared = {
        obj for obj in vars(diskio_spec).values()
        if inspect.isclass(obj) and issubclass(obj, DataSpec) and obj.__module__ == diskio_spec.__name__
    }
    assert declared == set(contract.VALUES)
    assert all(getattr(contract, value.__name__) is value for value in contract.VALUES), "re-exported"
    kinds = [value.spec_kind for value in contract.VALUES]
    assert len(set(kinds)) == len(kinds), "one kind per value class"


def test_the_builtin_kinds_import_reaches_the_values():
    assert "flow_sdk.schema.data_spec.diskio_spec" in inspect.getsource(register_builtin_kinds)


def test_contract_version_is_an_integer():
    assert type(contract.CONTRACT_VERSION) is int and contract.CONTRACT_VERSION >= 1
