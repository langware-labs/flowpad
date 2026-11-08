"""The two files that record CLI use of the engine (FLOWPAD-2250); written by
``flow_sdk/cli/cli_use.py`` and read by the Windows uninstaller (Rust), which reads the same keys."""

from __future__ import annotations

from flow_sdk.schema.data_spec.spec import DataSpec


class CliUseStamp(DataSpec):
    """``<instance_dir>/.cli_used``: this instance was driven by ``flow`` outside the desktop."""

    first: float
    last: float
    version: str


class CliStampSince(DataSpec):
    """``<flow_home>/global/cli-stamp-since``: the first engine that stamps CLI use."""

    version: str
    since: float
    preexisting: list[str]
