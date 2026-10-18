"""Run one ``ProcessCall`` here and answer with a ``ReturnedValue``.

The agent leg of ``compute_op.runner._agent`` (the same result contract, the same
receipt reader), with two differences a call that came from someone else needs:
the receipt lives in a private temp folder, never in the project the agent works in,
and the prompt is not kept on the process row.
"""

import tempfile
from pathlib import Path

from flow_sdk.core.compute.process_step import launch_step_process
from flow_sdk.core.compute.receipt import read_step_result, result_contract
from flow_sdk.schema.data_spec.compute_op_spec import AgentOp
from flow_sdk.schema.data_spec.process_call_spec import ProcessCall
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, PromptResult, ReturnedValue

#: The receipt key the agent writes its one-sentence outcome under.
OUTCOME_KEY = "outcome"
#: The agent a prompt call runs as (``agentic-assets/agent/prompt-runner``).
PROMPT_AGENT = "prompt-runner"
#: What the answer says when the agent wrote no account of its own.
MISSING_RESULT = "Missing result — the run ended without reporting how it went."


async def run_process_call(call: ProcessCall, *, workdir: Path) -> ReturnedValue:
    """Never raises. good = ``OK``; bad = ``NOT_YET`` + ``reported``; error = ``NOT_YET``, not reported."""
    exe = call.exe
    if not isinstance(exe, AgentOp):
        return ReturnedValue.not_applicable("This kind of call cannot run here yet.")
    with tempfile.TemporaryDirectory(prefix="process-call-") as tmp:
        path = Path(tmp) / "result.json"  # a fresh folder: no stale receipt to clear
        said = await launch_step_process(
            agent=exe.agent,
            prompt=exe.prompt + result_contract(path, OUTCOME_KEY, "<one sentence: what you did>"),
            # Never the prompt: it is the sender's text, and the process row is indexed and kept.
            name="Prompt call",
            workdir=workdir,
            timeout_seconds=exe.timeout(),
            remember_prompt=False,
            # The sender's trace: the agent's own calls join that run, under this call.
            context_data={"invocation_id": call.invocation_id or call.call_id, "call_id": call.call_id},
        )
        if not said.ok:
            return said
        receipt = read_step_result(path, output=OUTCOME_KEY)
    if receipt.ok:
        outcome = receipt.value if isinstance(receipt.value, str) else ""
        return said.model_copy(update={"detail": outcome or receipt.summary or "Done.", "reported": True})
    if not receipt.reported:
        return said.model_copy(update={"exit_code": ExitCode.NOT_YET, "detail": MISSING_RESULT, "reported": False})
    return said.model_copy(
        # The agent's own sentence first: ``error`` is prefixed with ours ("the agent reported failure: ...").
        update={"exit_code": ExitCode.NOT_YET, "detail": receipt.summary or receipt.error, "reported": True}
    )


def prompt_call(text: str) -> ProcessCall:
    """A one-shot prompt for the receiver to run — the first kind of call a message carries."""
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415

    return ProcessCall(call_id=mint_uuid(), exe=AgentOp(agent=PROMPT_AGENT, prompt=text))


def declined() -> ReturnedValue:
    return PromptResult.refused("Declined.")
