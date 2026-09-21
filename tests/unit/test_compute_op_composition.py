"""Two ops in sequence, with a value between them — and no wizard.

The scenario in `docs/snippets/compute-ops.md`: one op obtains a value (from a
person, in the real thing), a second op needs it, and the second must FAIL
rather than run with nothing. Told as one story, because the order is the point:

    1. the consumer is blocked, and the answer names the op that blocked it
    2. the producer is satisfied once the value exists, and is not re-asked
    3. the consumer succeeds, and the value is there

**No stubs.** Every command below is a real subprocess through the real
``run_shell``; the "machine state" is real files under ``tmp_path``. A stubbed
shell here would assert that the runner calls a function we wrote, which is the
one thing never in doubt. In particular step 3 proves the value ARRIVED by
having the command fail when it did not — not by inspecting what we passed.

The one thing that cannot be real is raising the question: ``AttemptKind.ASK``
does not exist, so the producer's attempt is a command that runs and does not
satisfy — which is exactly what an unanswered ask looks like to the runner.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

from flow_sdk.core.compute_op import run_op
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

HERE = sys.platform


def _specs(tmp: Path) -> dict[str, ComputeOpSpec]:
    token, served = tmp / "token", tmp / "served"
    get_key = ComputeOpSpec.model_validate({
        "name": "get-api-key",
        "label": "API token",
        # The check PROVES the value and YIELDS it: one command both exits 0
        # and prints what it found, the way `flow secret get` does.
        "completion_check": {"commands": {HERE: f"cat {token}"}},
        # Stands in for the question. It runs, and the goal still does not hold.
        "attempts": [{"kind": "command", "commands": {HERE: "true"}}],
        "output": {"token": "string"},
    })
    start = ComputeOpSpec.model_validate({
        "name": "start-server",
        "label": "server",
        "requires": ["get-api-key"],
        "completion_check": {"commands": {HERE: f"test -f {served}"}},
        # Fails loudly when $token is absent — so the assertion is about what
        # the command RECEIVED, not about what the test handed the runner.
        "attempts": [{"kind": "command", "commands": {
            HERE: f'test -n "$token" && echo "$token" > {served}'}}],
    })
    return {"get-api-key": get_key, "start-server": start}


def _resolver(specs):
    async def resolve(name):
        return specs.get(name)
    return resolve


async def _run(spec, specs, tmp_path):
    """The REAL shell. Only the spec lookup is injected, because a registry
    read is not what any of these cases is about."""
    return await run_op(spec, trusted=True, workdir=Path(tmp_path), platform=HERE,
                        resolve=_resolver(specs))


def _answer(tmp_path: Path) -> None:
    """The person answers — the only thing a test can legitimately stand in for."""
    (tmp_path / "token").write_text('{"token": "sk-live-1"}\n', encoding="utf-8")


async def test_the_consumer_is_blocked_while_the_value_is_missing(tmp_path):
    """The half that already works, and it is the half that matters for safety."""
    specs = _specs(tmp_path)

    blocked = await _run(specs["start-server"], specs, tmp_path)

    assert blocked.ok is False
    assert blocked.exit_code is ExitCode.NOT_YET
    # The blocker is identified by its LABEL, not by the name `requires` uses —
    # friendlier to read, and nothing in the sentence maps back to
    # `requires: ["get-api-key"]`.
    assert blocked.detail.startswith("API token:")
    assert not (tmp_path / "served").exists(), (
        "start-server ran with no token — a missing value reached the command line"
    )


async def test_a_satisfied_op_is_not_asked_again(tmp_path):
    """Convergence: once the answer exists, the attempt is not run."""
    specs = _specs(tmp_path)
    first = await _run(specs["get-api-key"], specs, tmp_path)
    assert first.ok is False, "unanswered: the attempt ran and the goal still does not hold"
    assert first.ran is True

    _answer(tmp_path)
    again = await _run(specs["get-api-key"], specs, tmp_path)

    assert again.ok is True
    assert again.ran is False, "a satisfied op reports skipped, not completed"


async def test_the_value_reaches_the_op_that_required_it(tmp_path):
    """Composition without a wizard: A's answer becomes B's input.

    This was an xfail recording three drops — `check_op` kept only the exit
    code, a satisfied op returned no value, and `_requires` discarded a
    successful dependency's answer. Until all three closed, a wizard was the
    only thing that could move a value between two units of work.
    """
    specs = _specs(tmp_path)
    _answer(tmp_path)

    got = await _run(specs["get-api-key"], specs, tmp_path)
    assert got.value.token == "sk-live-1", "a satisfied op must still yield its value"

    served = await _run(specs["start-server"], specs, tmp_path)
    assert served.ok is True
    assert (tmp_path / "served").read_text().strip() == "sk-live-1", (
        "the dependency's value did not reach the op that required it"
    )
