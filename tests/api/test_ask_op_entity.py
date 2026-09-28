"""The ask op through the ENTITY — `ComputeOp.by_name(...)` then `.run()`.

This is the API the snippets in `docs/snippets/compute-ops.md` teach, and until
this file nothing in the repo exercised it: every other test calls the pure
`run_op(spec, …)`. The two are not the same call — the entity reads the
document from disk, claims an Activity address, and answers REFUSED for an
unapproved op instead of asking anyone.

No mocks: a real document on disk, a real row, a real run, an answer delivered
through the same route the window posts to.
"""
from __future__ import annotations

import asyncio
from typing import ClassVar

import pytest

from flow_sdk.builtin.compute_op import ComputeOp
from flow_sdk.core.compute_op.ask import open_questions
from flow_sdk.schema.data_spec.returned_value_spec import AskResult, ExitCode
from flow_sdk.schema.data_spec.spec import DataSpec

pytestmark = pytest.mark.timeout(60)  # do not increase timeout without approval


class ApiToken(DataSpec):
    """The shape the op asks for — a registered kind, as `output_spec_kind` requires."""

    spec_kind: ClassVar[str] = "service_x.api_token"
    token: str


#: The document the snippets page shows.
DOCUMENT = {
    "type": "compute_op",
    "name": "get-api-key",
    "subkind": "ask",
    "exe_data": {"prompt": "Service X API token"},
    "output_spec_kind": "service_x.api_token",
}


@pytest.fixture(autouse=True)
def _no_browser(monkeypatch):
    # The registry itself is cleared for every api test — see tests/api/conftest.
    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")


@pytest.fixture
async def key(client):
    """A real ComputeOp, written by the entity itself — then found BY NAME.

    Not a hand-placed file: `save()` on a new row materializes the document,
    so a pre-written one collides with it. Letting the entity write it is also
    the path a real author's op takes.
    """
    found = await ComputeOp.by_name("get-api-key")
    if found is None:
        # The api tier shares one scope across tests, and the document outlives
        # the test that wrote it — so write it once, then find it by name.
        from flow_sdk.schema.data_spec.compute_op_spec import AskOp  # noqa: PLC0415

        fields = {k: v for k, v in DOCUMENT.items() if k != "type"}
        fields["exe_data"] = AskOp(**fields["exe_data"])
        await ComputeOp(**fields).save()
        found = await ComputeOp.by_name("get-api-key")
    assert found is not None, "by_name did not find the op the snippet asks for"
    return found


async def _person(client, *, answer=None, cancel=False) -> None:
    for _ in range(400):
        if open_questions():
            qid = open_questions()[0].id
            path = f"/api/v1/ask/{qid}/cancel" if cancel else f"/api/v1/ask/{qid}/answer"
            sent = await client.post(path, json=None if cancel else {"value": answer})
            assert sent.status_code == 200, sent.text
            return
        await asyncio.sleep(0.05)
    raise AssertionError("the op never raised a question")


async def test_an_unapproved_op_refuses_rather_than_asking(key):
    """`key.run()` with no approval answers REFUSED — returned, never raised —
    and never puts a question to anyone."""
    answer = await key.run()
    assert answer.exit_code is ExitCode.REFUSED and answer.ran is False
    assert open_questions() == [], "a refused op must not have asked anybody"


async def test_ask_and_get_what_they_typed(client, key):
    run = asyncio.create_task(key.run(approved=True))
    await _person(client, answer={"token": "fghfg"})
    answer = await run

    assert isinstance(answer, AskResult)
    assert answer.exit_code is ExitCode.OK
    assert isinstance(answer.value, ApiToken) and answer.value.token == "fghfg"


async def test_they_cancel(client, key):
    run = asyncio.create_task(key.run(approved=True))
    await _person(client, cancel=True)
    answer = await run

    assert answer.exit_code is ExitCode.NOT_YET and answer.cancelled is True
    assert answer.value is None


async def test_a_wrong_shape_is_refused_and_the_question_stays_open(client, key):
    run = asyncio.create_task(key.run(approved=True))
    for _ in range(400):
        if open_questions():
            break
        await asyncio.sleep(0.05)
    qid = open_questions()[0].id

    bad = await client.post(f"/api/v1/ask/{qid}/answer", json={"value": {"token": ["not", "text"]}})
    assert bad.status_code == 422
    assert (await client.get(f"/api/v1/ask/{qid}")).status_code == 200, "still open to correct"

    await client.post(f"/api/v1/ask/{qid}/answer", json={"value": {"token": "fixed"}})
    answer = await run
    assert answer.exit_code is ExitCode.OK
    assert answer.value.token == "fixed"


async def test_compute_ops_1_runs_as_written(client, key):
    """``compute-ops.md`` §1, run verbatim: the op is found by name and a person's answer comes back."""
    from tests.utils.snippets import doc, fence_under, run_fence

    person = asyncio.create_task(_person(client, answer={"token": "sk-live-1"}))
    ns = await run_fence(fence_under(doc("compute-ops.md"), "1."), {}, filename="compute-ops.md §1")
    await person
    assert ns["answer"].exit_code is ExitCode.OK and ns["answer"].value.token == "sk-live-1"


async def test_compute_ops_2_runs_as_written(key):
    """``compute-ops.md`` §2, run verbatim: once the completion check holds, nobody is asked again and the
    value is read off what the check printed."""
    import sys

    from flow_sdk.schema.data_spec.compute_op_spec import CliOp
    from tests.utils.snippets import doc, fence_under, run_fence

    key.completion_check = CliOp(commands={sys.platform: 'echo \'{"token": "sk-live-2"}\''})
    await key.save()
    try:
        ns = await run_fence(fence_under(doc("compute-ops.md"), "2."), {}, filename="compute-ops.md §2")
        assert ns["answer"].ok and ns["answer"].ran is False
        assert ns["answer"].value.token == "sk-live-2"
        assert open_questions() == [], "nobody was asked"
    finally:
        key.completion_check = None
        await key.save()
