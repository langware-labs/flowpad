"""The backend starts, and ``flow diagnose`` runs, when usearch cannot load.

usearch's compiled module links ``MSVCP140.dll`` (the Microsoft Visual C++ Runtime).
Python bundles only ``vcruntime140*.dll``, and a clean Windows install has no
``MSVCP140.dll`` — so on a fresh machine ``import usearch`` raises ``ImportError: DLL
load failed``. A dead field on ``FlowExecutionContext`` pulled the legacy knowledge base
(and with it usearch) into the server's import graph, so that one missing DLL took down
``flow start`` and ``flow diagnose`` alike. Only RAG needs usearch, and it imports it on
first use. A fresh interpreter is the only honest probe: in-process, some earlier test has
already imported it.
"""

import subprocess
import sys
import textwrap

import pytest

_PROBE = textwrap.dedent(
    """
    import importlib.abc
    import sys

    class _NoUsearch(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path=None, target=None):
            if name == "usearch" or name.startswith("usearch."):
                raise ImportError("DLL load failed while importing compiled (simulated)")

    sys.meta_path.insert(0, _NoUsearch())

    import flow_sdk.server.app  # noqa: F401
    import flow_sdk.cli.commands.diagnose_cmd  # noqa: F401
    from flow_sdk.migrations.runner import _bootstrap_local  # noqa: F401

    assert "usearch" not in sys.modules
    print("OK")
    """
)


@pytest.mark.long  # 3.2s
def test_server_and_diagnose_import_without_usearch() -> None:
    proc = subprocess.run([sys.executable, "-c", _PROBE], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr[-4000:]
    assert proc.stdout.strip().endswith("OK")
