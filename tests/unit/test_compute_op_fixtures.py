"""The ten ops the Docker rig runs, checked without Docker.

Docker is slow and needs a key; a malformed document should not cost a container
build to discover. These are the same files ``tests/long_tests/test_compute_op_in_docker.py``
copies in, so a typo here fails in milliseconds instead of minutes.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec

OPS = Path(__file__).resolve().parents[1] / "long_tests" / "compute_ops"
NAMES = sorted(p.name for p in OPS.iterdir() if p.is_dir())


def _spec(name: str) -> ComputeOpSpec:
    folder = OPS / name
    body = json.loads((folder / "compute_op.json").read_text())
    body.pop("type", None)
    return ComputeOpSpec.model_validate({**body, "setup": (folder / "setup.md").read_text()})


def test_the_rig_has_its_eleven_cases():
    assert len(NAMES) == 11, NAMES


@pytest.mark.parametrize("name", NAMES)
def test_every_op_parses_and_is_addressable_by_its_folder(name):
    spec = _spec(name)
    # The folder name IS the handle `flow op run` uses; a document
    # whose `name` drifts from its folder is unreachable by the name people type.
    assert spec.name == name
    assert spec.display_label
    assert spec.completion_check.command_for("linux"), "a goal with no question cannot be proven"


@pytest.mark.parametrize("name", NAMES)
def test_every_op_says_how_a_person_would_do_it(name):
    # `setup` is what the agent rung is handed. An op without it asks a model to
    # invent a procedure for someone's machine.
    assert _spec(name).setup.strip(), f"{name} ships no setup.md"


def test_the_cases_cover_the_mechanisms_they_were_chosen_for():
    specs = {name: _spec(name) for name in NAMES}

    # The three that prove the design: a cheap rung that fails or reports success
    # while the goal is still unmet, so the agent rung has to exist. git and uv
    # ship in the container image, so neither could ever escalate there.
    for name in ("ripgrep-on-path", "cowsay-on-path", "app-answers"):
        kinds = [str(attempt.kind) for attempt in specs[name].attempts]
        assert kinds == ["command", "agent"], f"{name} must escalate, got {kinds}"

    # A skip that is not a failure.
    assert specs["apk-cache-warm"].not_applicable_codes == [3]
    # The negative.
    assert specs["unreachable"].attempts, "the negative case must still TRY something"
