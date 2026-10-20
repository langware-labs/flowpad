"""Every module that declares a ``spec_kind`` is imported by ``register_builtin_kinds()``.

A kind registers when its module is imported; one nobody imports resolves to ``Any`` with no
error anywhere (CLAUDE.md, "Registration is import-time"). Run in a fresh interpreter so another
test's imports cannot hide a missing one."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import flow_sdk.schema.data_spec as data_spec

_DECLARES = re.compile(r"^\s+spec_kind\s*(?::[^=]+)?=\s*[\"'][^\"']+[\"']", re.M)


def test_every_kind_module_is_reachable_from_register_builtin_kinds():
    root = Path(data_spec.__file__).parent
    modules = sorted(
        "flow_sdk.schema.data_spec." + ".".join(p.relative_to(root).with_suffix("").parts)
        for p in root.rglob("*.py")
        if _DECLARES.search(p.read_text(encoding="utf-8"))
    )
    assert modules, "found no kind modules: the scan is broken"
    probe = (
        "import sys, json\n"
        "from flow_sdk.schema.data_spec._kinds import register_builtin_kinds\n"
        "register_builtin_kinds()\n"
        f"print(json.dumps([m for m in {modules!r} if m not in sys.modules]))\n"
    )
    out = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, check=True)
    missing = out.stdout.strip().splitlines()[-1]
    assert missing == "[]", f"never imported by register_builtin_kinds(), so their kinds resolve to Any: {missing}"
