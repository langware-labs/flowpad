"""Asking a person for a value, and waiting for the answer.

One pending question at a time per id, held in memory with an
``asyncio.Future``. The answer arrives through an HTTP action and resolves the
future; nothing is persisted, because a restart ends the wait either way — the
future, and whatever awaits it, both live in this process and die with it.

**The wait is USUALLY bounded.** A caller holding a ``ReturnedValue`` needs an
answer or a reason, so the question gets a deadline — the caller's, else the
op's own, else ``ASK_TIMEOUT_SECONDS`` (``compute_op_spec``, beside the other
four) — and the op answers ``NOT_YET`` when it passes. A long wait is a long
deadline, and a question left unanswered is asked again when its wizard
resumes. The one exception is an op declared ``until_answered`` — install-time
infrastructure the app cannot proceed without — which waits with NO deadline:
until answered, cancelled, or the process restarts. It pays for that with one
rule: a question nobody could be shown (no live tab, no browser — a headless
sandbox) is dropped after a short presence grace instead, because an unbounded
wait with nobody to answer never ends.

**The question lives where answers arrive.** The future is held by the process
that serves the answer routes — the backend. ``run_op`` running there asks
directly (:func:`ask_person`). Anywhere else — a script, a spawned worker — it
hands the whole question to the backend (:func:`ask_through_backend`), which
raises it, waits the same bounded time and answers; the caller keeps its lease
on that backend for the length of the wait, so one it had to start is not
stopped under the person answering. Before this, an op asked from outside the
backend registered its question where no answer could reach it.
"""

from __future__ import annotations

import asyncio
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Optional

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.schema.data_spec.returned_value_spec import AskResult


class Cancelled(Exception):
    """The person declined to answer. Not a failure of the machine."""


@dataclass
class Question:
    """One value being asked for, and the shape it must satisfy."""

    id: str
    op_name: str
    prompt: str
    #: The op's ``output_spec_kind`` — the kind the answer is held to. There is
    #: exactly one declaration; this is it.
    shape: Any = None
    #: That kind opened one level — what a form draws. Computed once, when the
    #: question is raised: it cannot change while the question is open.
    fields: Any = None
    #: A plain-language paragraph shown under the prompt (``AskOp.detail``).
    detail: str = ""
    #: The button words (``AskOp.submit_label`` / ``cancel_label``). Empty: the
    #: window's defaults, Send / Cancel.
    submit_label: str = ""
    cancel_label: str = ""
    #: The answer is a secret: whoever draws the field masks it, and nothing echoes it.
    secret: bool = False
    #: The answer is a file's content: whoever draws the field offers a file picker and a paste box.
    file: bool = False
    #: The Wizard entity this question is a step of, when it is one — its
    #: TypeId's uuid half. Empty for an op run outside any wizard. This is the
    #: one thread back from a settled question to the run that is still going:
    #: without it, answering felt like the last step, even when five more were
    #: about to run right after.
    wizard_id: str = ""
    #: The wizard run that asked (its activity address), when one did. A screen showing that run
    #: claims the question and draws it in place; nobody claiming it, it opens on its own.
    run: str = ""
    #: How a person finds the value — the op's ``setup.md``, markdown. Drawn beside the fields.
    guide: str = ""
    #: The agent the person can hand this question to (``AskOp.assist_agent``). Empty: no AI Assist.
    assist_agent: str = ""
    #: How long the question waits once that agent starts, and how long the agent gets.
    setup_timeout: float = 0.0
    #: Where the agent works — the asking op's working directory.
    workdir: str = ""
    #: The assist, once started: ``running`` / ``failed`` / ``done``, what it last said, and its process.
    assist_state: str = ""
    assist_detail: str = ""
    assist_process: str = ""
    #: When the wait ends, in loop time — ``None`` while nobody waits, or for an op with no deadline.
    #: Moved only forward, by :func:`extend`.
    deadline: Optional[float] = None
    #: The asking step's status line (its row in the wizard) — where the assist reports as it works.
    _say: Optional[Callable[[str], None]] = field(repr=False, default=None)
    _assist_task: "Optional[asyncio.Task]" = field(repr=False, default=None)
    _future: "asyncio.Future" = field(repr=False, default=None)  # type: ignore[assignment]

    def to_payload(self) -> dict:
        """What a UI needs to draw the field. Never the future."""
        return {
            "id": self.id,
            "op": self.op_name,
            "prompt": self.prompt,
            "detail": self.detail,
            "submit_label": self.submit_label,
            "cancel_label": self.cancel_label,
            # The declared kind by NAME, when it is one.
            "kind": self.shape if isinstance(self.shape, str) else None,
            "fields": self.fields,
            "secret": self.secret,
            "file": self.file,
            "wizard_id": self.wizard_id,
            "run": self.run,
            "guide": self.guide,
            "assist_available": bool(self.assist_agent),
            "assist": self.assist_payload(),
        }

    def assist_payload(self) -> Optional[dict]:
        if not self.assist_state:
            return None
        return {"state": self.assist_state, "detail": self.assist_detail, "process": self.assist_process}


#: The wizard run the current task is executing, set by ``execute_wizard`` for the length of a
#: run. A question opened inside it is stamped with it (``Question.run``).
ASKING_RUN: ContextVar[str] = ContextVar("asking_run", default="")


#: Whether THIS process serves the answer routes — set by the app that mounts
#: them. Only then can a future held here be resolved by an answer.
_SERVED_HERE = False


def serve_here() -> None:
    """Declare that answers arrive in this process (the backend mounting the routes)."""
    global _SERVED_HERE
    _SERVED_HERE = True


def served_here() -> bool:
    return _SERVED_HERE


@contextmanager
def answered_here():
    """For the length of the block, THIS process is where answers arrive — a CLI that answers its
    own questions on its terminal (``flow project setup``). Restored after, so nothing else run
    in the process later mistakes it for the backend."""
    global _SERVED_HERE
    prior, _SERVED_HERE = _SERVED_HERE, True
    try:
        yield
    finally:
        _SERVED_HERE = prior


#: Questions waiting for an answer, by id. Empty between asks: a question is
#: removed the moment it is answered, cancelled or times out, so a stale id can
#: never be answered twice or resolve a future nobody is awaiting.
_PENDING: "dict[str, Question]" = {}


def open_question(
    op_name: str,
    prompt: str,
    shape: Any,
    *,
    detail: str = "",
    submit_label: str = "",
    cancel_label: str = "",
    secret: bool = False,
    file: bool = False,
    wizard_id: str = "",
    guide: str = "",
    assist_agent: str = "",
    setup_timeout: float = 0.0,
    workdir: str = "",
    say: Optional[Callable[[str], None]] = None,
) -> Question:
    """Register a question and return it. The caller then awaits ``wait_for``."""
    from flow_sdk.schema.data_spec.compute_op_spec import fields_of_kind  # noqa: PLC0415

    question = Question(
        id=str(uuid.uuid4()),
        op_name=op_name,
        prompt=prompt,
        shape=shape,
        # A kind string alone would render as one unnamed box.
        fields=fields_of_kind(shape) if isinstance(shape, str) else shape,
        detail=detail,
        submit_label=submit_label,
        cancel_label=cancel_label,
        secret=secret,
        file=file,
        wizard_id=wizard_id,
        run=ASKING_RUN.get(),
        guide=guide,
        assist_agent=assist_agent,
        setup_timeout=setup_timeout,
        workdir=workdir,
        _say=say,
        _future=asyncio.get_event_loop().create_future(),
    )
    _PENDING[question.id] = question
    return question


def pending(question_id: str) -> Optional[Question]:
    """The question with this id, or None once it is settled."""
    return _PENDING.get(question_id)


def open_questions() -> "list[Question]":
    """Every question currently waiting. The UI's list; also what a test reads."""
    return list(_PENDING.values())


def _settle(question_id: str, resolve) -> bool:
    """Hand one question its ending. False when nothing is waiting under that id.

    Both endings are the same three steps — take it out of the registry, refuse
    a second ending, resolve the future — and differ only in what they resolve
    it WITH. Keeping that in one place is why a settled question can never be
    settled twice by one path and not the other.
    """
    question = _PENDING.pop(question_id, None)
    if question is None or question._future.done():
        return False
    resolve(question._future)
    return True


def answer(question_id: str, value: Any) -> bool:
    """Deliver an answer.

    The value is NOT validated here: validation belongs to the action, so a
    person who typed the wrong thing gets a correctable error instead of an op
    that failed on their behalf.
    """
    return _settle(question_id, lambda future: future.set_result(value))


def cancel(question_id: str) -> bool:
    """Decline to answer. The op hears "no value", not "something broke"."""
    return _settle(question_id, lambda future: future.set_exception(Cancelled()))


def forget(question_id: str) -> None:
    """Drop a question nobody will wait for — one that was never shown."""
    _PENDING.pop(question_id, None)


async def wait_for(question: Question, *, timeout: Optional[float]) -> Any:
    """The answer, or ``TimeoutError``/``Cancelled``.

    ``timeout`` is required: the deadline is the caller's or the OP's, resolved
    before it gets here, and a default here would be a second opinion about how
    long a person gets. ``None`` is an ``until_answered`` op's: no deadline.

    The question is forgotten on every exit, so a late answer to a question
    nobody is waiting for is refused rather than silently dropped into a future
    that has already been abandoned.
    """
    loop = asyncio.get_running_loop()
    question.deadline = None if timeout is None else loop.time() + timeout
    answered = False
    try:
        while True:
            left = None if question.deadline is None else question.deadline - loop.time()
            if left is not None and left <= 0:
                raise TimeoutError
            try:
                value = await asyncio.wait_for(asyncio.shield(question._future), left)
            except TimeoutError:
                # The deadline moved while we waited (an assist started): wait out the rest of it.
                if question.deadline is not None and question.deadline > loop.time():
                    continue
                raise
            answered = True
            return value
    finally:
        _PENDING.pop(question.id, None)
        task = question._assist_task
        if not answered and task is not None and not task.done():
            # Nobody waits for the answer any more (cancelled, timed out): the agent stops too.
            task.cancel()


def extend(question_id: str, seconds: float) -> bool:
    """Wait at least ``seconds`` more from now. Never shortens, and a question with no deadline keeps
    none. False when nothing is waiting under that id."""
    question = _PENDING.get(question_id)
    if question is None:
        return False
    if question.deadline is not None:
        question.deadline = max(question.deadline, asyncio.get_running_loop().time() + seconds)
    return True


#: How long an ``until_answered`` ask keeps checking for SOMEONE to show the
#: question to before it concludes nobody is there at all. This is presence,
#: not an answer — the boot race it exists for: ``app.ready`` fires once its own
#: index walk finishes (``_app_ready_signal``), which the app's own tab is racing
#: to have a live WS connection ready for. A wide-open desktop window usually
#: wins that race easily; a genuinely headless box (a sandbox, a CI runner)
#: never will, and gives up here rather than never.
PRESENCE_GRACE_SECONDS = 15.0
PRESENCE_POLL_SECONDS = 1.0


async def ask_person(
    op_name: str,
    prompt: str,
    shape: Any,
    *,
    timeout: Optional[float],
    label: str,
    detail: str = "",
    submit_label: str = "",
    cancel_label: str = "",
    secret: bool = False,
    file: bool = False,
    wizard_id: str = "",
    guide: str = "",
    assist_agent: str = "",
    setup_timeout: float = 0.0,
    workdir: str = "",
    say: Optional[Callable[[str], None]] = None,
    assist_now: bool = False,
) -> "AskResult":
    """Raise one question here and answer with what the person did.

    A cancel and a timeout are both "no value" — ``NOT_YET`` — and differ in
    ``cancelled`` / ``timed_out``, which is what a caller branches on.
    ``timeout=None`` (an ``until_answered`` op) waits with no deadline, but
    only for a question someone could actually be shown.
    """
    from flow_sdk.core.compute_op.ask_window import raise_question  # noqa: PLC0415
    from flow_sdk.schema.data_spec.returned_value_spec import AskResult  # noqa: PLC0415

    question = open_question(
        op_name,
        prompt,
        shape,
        detail=detail,
        submit_label=submit_label,
        cancel_label=cancel_label,
        secret=secret,
        file=file,
        wizard_id=wizard_id,
        guide=guide,
        assist_agent=assist_agent,
        setup_timeout=setup_timeout,
        workdir=workdir,
        say=say,
    )
    shown = await raise_question(question)
    if timeout is None and not shown:
        # No deadline: give a live tab the presence grace window before
        # concluding nobody is there — see `PRESENCE_GRACE_SECONDS`.
        # `try_window=False`: the one browser-open attempt already happened
        # above (or was skipped, e.g. `FLOWPAD_NO_BROWSER`); retrying it here
        # would spam a fresh tab on every poll instead of failing the same way
        # every time.
        elapsed = 0.0
        while not shown and elapsed < PRESENCE_GRACE_SECONDS:
            await asyncio.sleep(PRESENCE_POLL_SECONDS)
            elapsed += PRESENCE_POLL_SECONDS
            shown = await raise_question(question, try_window=False)
    if timeout is None and not shown:
        # No deadline and nobody to answer is a run that never ends. Nothing
        # was asked, so nothing ran; the next attempt asks again.
        forget(question.id)
        return AskResult.not_yet(f"{label}: nobody could be shown the question.", ran=False)
    if assist_now and assist_agent:
        # Asked on the person's behalf by a terminal that handed it straight to AI Assist: the agent
        # starts at once, and the wait is the setup's own span from here.
        if timeout is not None:
            timeout = max(timeout, setup_timeout)
        assist(question.id)
    started = asyncio.get_running_loop().time()
    try:
        value = await wait_for(question, timeout=timeout)
    except asyncio.CancelledError:
        # The caller gave up on the answer (a replaced setup run): take the
        # question off the person's screen too. Shielded, so the close is sent.
        from flow_sdk.core.compute_op.ask_window import withdraw_question  # noqa: PLC0415

        await asyncio.shield(withdraw_question(question))
        raise
    except Cancelled:
        return AskResult.not_yet(f"{label}: cancelled.", cancelled=True)
    except TimeoutError:
        # The span actually waited: an assist extends the deadline past ``timeout``.
        waited = asyncio.get_running_loop().time() - started
        return AskResult.not_yet(f"{label}: no answer within {waited:.0f}s.", timed_out=True)
    return AskResult.satisfied(f"{label}: answered.", value=value)


async def ask_through_backend(
    op_name: str,
    prompt: str,
    shape: Any,
    *,
    timeout: Optional[float],
    label: str,
    detail: str = "",
    submit_label: str = "",
    cancel_label: str = "",
    secret: bool = False,
    file: bool = False,
    wizard_id: str = "",
    guide: str = "",
    assist_agent: str = "",
    setup_timeout: float = 0.0,
    workdir: str = "",
    say: Optional[Callable[[str], None]] = None,
    assist_now: bool = False,
) -> "AskResult":
    """:func:`ask_person`, run by the backend for a process that is not it.

    One request for the whole wait: the backend's route owns the deadline (the
    same ``timeout``), so the client adds none of its own. The lease is held
    across it — a backend this call had to start stays up until the person has
    answered or the time is up.
    """
    from flow_sdk.core.connections.service import FlowServiceError, flow_service  # noqa: PLC0415
    from flow_sdk.schema.data_spec.returned_value_spec import AskResult  # noqa: PLC0415

    body = {
        "op": op_name,
        "prompt": prompt,
        "shape": shape,
        "timeout": timeout,
        "label": label,
        "detail": detail,
        "submit_label": submit_label,
        "cancel_label": cancel_label,
        "secret": secret,
        "file": file,
        "wizard_id": wizard_id,
        "guide": guide,
        "assist_agent": assist_agent,
        "setup_timeout": setup_timeout,
        "workdir": workdir,
        "assist_now": assist_now,
    }
    try:
        async with flow_service() as lease:
            said = await lease.client.request("POST", "/api/v1/ask", json=body)
    except FlowServiceError as exc:
        return AskResult.not_yet(f"{label}: no Flowpad backend to ask through — {exc.detail}", ran=False)
    if not said.success or not isinstance(said.data, dict):
        return AskResult.not_yet(f"{label}: the backend did not ask — {said.message or said.status}", ran=False)
    return AskResult.model_validate(said.data)


# ── AI Assist: an agent answers the same question ─────────────────────────────


class AssistRefused(ValueError):
    """An assist that cannot start: no agent for this question, it is settled, or one already works on it."""


def assist(question_id: str, *, launch: Any = None) -> dict:
    """Hand the question to its ``assist_agent``: the agent follows the op's guide and answers THIS
    question through ``flow ask answer`` — the route a person's answer takes — so the asking op returns
    the same ``AskResult`` whoever answered. From now, the question waits ``setup_timeout`` (the
    setup's own span, not a person's) and the agent is stopped at it. The person can still answer or
    cancel meanwhile; the first answer wins. Returns the assist's state."""
    question = _PENDING.get(question_id)
    if question is None:
        raise AssistRefused("that question is no longer waiting")
    if not question.assist_agent:
        raise AssistRefused("this question has no AI Assist")
    if question.assist_state == "running":
        raise AssistRefused("AI Assist is already working on it")
    extend(question_id, question.setup_timeout)
    question.assist_state, question.assist_detail, question.assist_process = "running", "starting the agent", ""
    question._assist_task = asyncio.create_task(_run_assist(question, launch))
    return question.assist_payload() or {}


def assist_prompt(question: Question) -> str:
    """The contract around the op's guide (which rides the agent op's ``setup``): where the value goes,
    and that it never passes through the agent's words."""
    from flow_sdk.core.flow_command import flow_command  # noqa: PLC0415

    if question.file:
        how = (
            "The answer is a FILE's content. Produce the file (a download, a generated key) and deliver it with:\n\n"
            f"    {flow_command('ask', 'answer', question.id, '--file', '<path to the file>')}\n\n"
            "then delete the file."
        )
    else:
        how = (
            "Deliver the value by piping it into:\n\n"
            f"    {flow_command('ask', 'answer', question.id, '--stdin')}"
        )
    return (
        f"A person is being asked: {question.prompt}\n"
        "They handed the question to you. Obtain the value by following the instructions below, "
        f"and answer the question with it.\n{how}\n\n"
        "That command is the only place the value goes. Produce it inside the pipe or file that feeds it, so it "
        "never passes through you: never print, echo or repeat a value — not in a command line, your reply, a "
        "file you keep or a log. If the command refuses the value, fix it and answer again. Where the "
        "instructions say to store the value some other way (`flow credentials set …`), answer the question "
        "instead: whoever asked stores it.\n"
        "If obtaining it needs the person (their sign-in, a code sent to them), say exactly what they must do, "
        "and stop — the question stays open for them."
    )


async def _run_assist(question: Question, launch: Any) -> None:
    from flow_sdk.core.compute_op.runner import run_op  # noqa: PLC0415
    from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec  # noqa: PLC0415

    def status(text: str) -> None:
        if not text:
            return
        question.assist_detail = text
        if question._say is not None:
            question._say(f"AI Assist: {text}")

    if launch is None:
        from flow_sdk.core.compute.process_step import launch_step_process as launch  # noqa: PLC0415

    async def tracked(**kwargs: Any) -> Any:
        """``launch``, noting the agent's process as soon as it reports, so the form can link to it."""
        inner = kwargs.get("on_status")

        def on_status(progress: Any) -> None:
            question.assist_process = getattr(progress, "executor", "") or question.assist_process
            if inner is not None:
                inner(progress)

        return await launch(**{**kwargs, "on_status": on_status})

    spec = ComputeOpSpec.model_validate({
        "name": f"{question.op_name}-assist",
        "label": f"AI Assist: {question.prompt.splitlines()[0] if question.prompt else question.op_name}",
        "subkind": "agent",
        "exe_data": {
            "agent": question.assist_agent, "prompt": assist_prompt(question),
            "timeout_seconds": question.setup_timeout,
        },
        "setup": question.guide,
    })
    try:
        said = await run_op(
            spec, trusted=True, workdir=Path(question.workdir) if question.workdir else None,
            on_status=status, launch=tracked,
        )
        detail = said.detail
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — a crashed assist leaves the question to the person
        detail = f"AI Assist could not run: {exc}"
    if question._future.done() or question.id not in _PENDING:
        question.assist_state = "done"
        return
    # Finished without answering: the question stays open, for the person or another try.
    question.assist_state = "failed"
    question.assist_detail = detail or "AI Assist finished without answering."
    if question._say is not None:
        question._say(question.assist_detail)
