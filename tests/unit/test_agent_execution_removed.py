"""Tests confirming AgentExecution has been removed."""

import importlib

import pytest

import flow_sdk.fs_records


def test_import_raises():
    """Importing AgentExecution raises ImportError."""
    with pytest.raises(ImportError):
        importlib.import_module("flow_sdk.fs_records.agent_execution")


def test_not_in_fs_records_init():
    """AgentExecution is not in flow_sdk.fs_records exports."""
    assert not hasattr(flow_sdk.fs_records, "AgentExecution")
