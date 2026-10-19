"""The agent loop a local deployment runs — written as a code snippet, and each deployment's own file
is this source (``deployment_process.file_of``), so what the person reads and edits IS the loop.

The regions (``core/snippet``): imports hidden, the loop shown, and — added in each deployment's
file — the one line that runs it (``agent_loop.main``: the deployment's lock, its terminal, and the
loop started again whenever the channels it answers change). The app's own default is this very
function (``agent_serve.serve``), so the stock file and the library cannot drift apart.
"""
# %% flowpad:hidden
from flow_sdk.blocks import StreamInbox, workflow
from flow_sdk.blocks.arrivals import stopping
from flow_sdk.blocks.merge import pages
from flow_sdk.builtin.agent_serve import answer, console, consumer_of, is_history, skip_message

# %% flowpad:snippet
async def answer_every_message(engine, channels, bound, every=None):
    """Answer every message on the agent's channels here, until the deployment is paused.

    Each message is skipped when it was written before the agent took its channel, else gated
    (an allowed sender, not our own echo), run as a turn in its conversation, and replied to on
    its own channel. A page is acked once it is handled — a restart resumes after it. *every* is how
    often the channels are re-read when nothing arrived (seconds; the channel's own pace when None).
    """
    async with workflow(consumer_of(engine.deployment)):  # this deployment's durable position
        async for page in pages(*(StreamInbox.of(c) for c in channels), poll_every=every, poll=False):
            if stopping():
                continue  # paused mid-page: left unacked, handed over again next time
            for message in page:
                if is_history(message, bound[page.source_id]):
                    console.info("· %s  written before the channel was bound: history, not answered", page.source_id)
                    await skip_message(message)
                    continue
                await answer(engine, message)
            await page.ack()
