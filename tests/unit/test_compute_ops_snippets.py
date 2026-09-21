"""Every op document on the compute-ops page is a document the loader accepts.

A snippet nobody validates is a snippet that drifts. Both fences on that page
were wrong when it was written — they said `command` where the spec takes
`commands: {platform: …}` — and nothing caught it, because the shelf's pinning
rule checks that a section NAMES a test, not that its fences parse.

This reads the page and validates every ```jsonc fence as a ComputeOpSpec, so
a reader who copies one gets a document that loads.
"""
from __future__ import annotations

import json
import re

import pytest

from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from tests.utils.snippets import SHELF

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PAGE = SHELF / "compute-ops.md"
_JSONC = re.compile(r"```jsonc\n(.*?)```", re.DOTALL)


def _documents() -> list[tuple[int, dict]]:
    """Each fence, with its // comments stripped the way jsonc means them."""
    out = []
    for n, block in enumerate(_JSONC.findall(PAGE.read_text(encoding="utf-8"))):
        bare = "\n".join(line for line in block.splitlines() if not line.strip().startswith("//"))
        out.append((n, json.loads(bare)))
    return out


def test_the_page_has_op_documents_to_check():
    assert len(_documents()) >= 2, "the fences moved or the page lost its examples"


@pytest.mark.parametrize("index", [n for n, _ in _documents()])
def test_every_op_document_on_the_page_is_loadable(index: int):
    body = dict(_documents()[index][1])
    ComputeOpSpec.model_validate(body)
