"""Execute the documented manifests, call.py files and chain literally."""
from __future__ import annotations

import re
import textwrap
from pathlib import Path

import pytest

DOC = Path(__file__).resolve().parents[2] / "docs/snippets/flowcall-blocks.md"


@pytest.mark.asyncio
async def test_documented_python_blocks_and_chain(tmp_path, monkeypatch):
    text = DOC.read_text()
    manifests = re.findall(r"```json\n(.*?)```", text, re.S)
    python = re.findall(r"```python\n(.*?)```", text, re.S)
    assert len(manifests) == 2 and len(python) == 3
    project = tmp_path / "agentic-assets/project_manifest"
    project.mkdir(parents=True)
    (project / "project_manifest.json").write_text('{"ns":"flowcall_examples"}')
    for name, manifest, code in zip(("dedupe", "sort"), manifests, python):
        folder = tmp_path / "agentic-assets/compute_op" / name
        folder.mkdir(parents=True)
        (folder / "compute_op.json").write_text(manifest)
        (folder / "call.py").write_text(code)
    monkeypatch.chdir(tmp_path)
    scope = {}
    exec("async def run_documented_example():\n" + textwrap.indent(python[2], "    "), scope)
    await scope["run_documented_example"]()
