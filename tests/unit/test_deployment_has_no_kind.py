"""A Deployment stores no kind and no slot — what it places is its parent (``docs/ontology.md`` rule 1).

The old vocabulary (``runtime.agent``, ``runtime.web``, ``compute.node``, ``compute.this_computer``, the
``KIND_*`` constants, ``slot``) must not creep back into the SDK, the TS SDK or the UI: a stored kind is a
second answer to "what does this place" that drifts from the first.
"""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ROOTS = [REPO / "flow_sdk", REPO / "ts_sdk" / "src", REPO / "ui" / "src"]
BANNED = re.compile(r"KIND_(AGENT|WEB|NODE|THIS_COMPUTER)\b|[\"'](runtime\.agent|runtime\.web|compute\.node|compute\.this_computer)[\"']")
#: The boot migration reads the OLD rows, so it names what it lifts.
ALLOWED = {REPO / "flow_sdk" / "migrations" / "migration_2026_09_this_computer_placement.py"}


def test_no_stored_deployment_kind_anywhere():
    hits = []
    for root in ROOTS:
        for path in root.rglob("*"):
            if path.suffix not in {".py", ".ts", ".tsx"} or path in ALLOWED or "node_modules" in path.parts:
                continue
            for n, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
                if BANNED.search(line):
                    hits.append(f"{path.relative_to(REPO)}:{n}: {line.strip()}")
    assert not hits, "a Deployment kind came back:\n" + "\n".join(hits)


def test_the_model_has_neither_kind_nor_slot():
    from flow_sdk.builtin.deployment import Deployment

    assert "kind" not in Deployment.model_fields
    assert "slot" not in Deployment.model_fields
    assert Deployment.model_fields["identity"].default == "user"


def test_what_a_deployment_places_is_its_parent():
    from flow_sdk.builtin.deployment import Deployment

    def placed(parent):
        return Deployment(name="x", parent_type_id=parent, target={"provider": "e2b", "scope": "s"})

    assert placed("agent-7b0f6c1e-3d2a-4f5b-9c8d-1e2f3a4b5c6d").element_type == "agent"
    assert placed("agent-7b0f6c1e-3d2a-4f5b-9c8d-1e2f3a4b5c6d").places_agent
    assert placed("project-7b0f6c1e-3d2a-4f5b-9c8d-1e2f3a4b5c6d").element_type == "project"
    assert placed("compute_node-7b0f6c1e-3d2a-4f5b-9c8d-1e2f3a4b5c6d").element_type == "compute_node"
    assert placed(None).element_type is None
