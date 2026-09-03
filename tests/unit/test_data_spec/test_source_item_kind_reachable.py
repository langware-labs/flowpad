"""``ingest.source_item`` must resolve after ``register_builtin_kinds()`` ALONE.

Kind registration is import-time and an unreachable kind compiles to ``Any``
with no error anywhere — so the spec lives in the schema layer and the kind
loader imports it. Proven in a fresh interpreter: nothing under
``flow_sdk.builtin`` may be what made it resolve.
"""
from __future__ import annotations

import subprocess
import sys

import pytest

pytestmark = pytest.mark.timeout(5)

# Reads the kind table directly: ``kind_type`` would ``_ensure_loaded`` the whole
# type registry, whose modules import the builtin row — which is exactly the
# import this test must prove is not what registered the kind.
_PROBE = """
import sys
from flow_sdk.schema.data_spec._kinds import register_builtin_kinds
register_builtin_kinds()
from flow_sdk.fs_store.schema_registry import SchemaRegistry
shape = SchemaRegistry._kinds.get("ingest.source_item")
print(getattr(shape, "__module__", None))
print("flow_sdk.builtin.source_item" in sys.modules)
"""


def test_kind_resolves_without_the_builtin_row_module():
    out = subprocess.run(
        [sys.executable, "-c", _PROBE], capture_output=True, text=True, check=True,
        env={"FLOWPAD_SKIP_DOTENV": "true", "PATH": ""},
    ).stdout.split()
    assert out == ["flow_sdk.schema.data_spec.source_item_spec", "False"], out


def test_builtin_re_export_is_the_same_class():
    from flow_sdk.builtin.source_item import SourceItemSpec as via_row
    from flow_sdk.schema.data_spec.source_item_spec import SourceItemSpec as via_spec

    assert via_row is via_spec
