"""The history ``StreamingResponseHandler`` keeps for late consumers.

Two things must hold at once: a consumer that attaches after the stream
started (or after it ended) sees exactly what an early one saw, and keeping
that history does not cost a copy of everything-so-far per chunk. The handler
used to do ``self._history += xml`` on every broadcast, which CPython can only
do by copying the whole string (an attribute cannot be extended in place):
261 µs per 200-char chunk at 32k chunks, 8.4 s of event-loop CPU for one turn,
and a 2x transient peak on every append.
"""

import asyncio
import tracemalloc

from flow_sdk.core.flow.models.flow_data import FlowData, FlowElementType
from flow_sdk.core.flow.streaming.response_handler import StreamingResponseHandler


def _chat(text: str, kind: str = FlowElementType.CHAT.value) -> FlowData:
    return FlowData(flow_value=text, attributes={"element-type": kind, "data-type": "text"})


async def _consume(handler: StreamingResponseHandler) -> str:
    return "".join([str(chunk) async for chunk in handler])


async def test_late_and_post_end_consumers_replay_the_same_history():
    handler = StreamingResponseHandler()
    kinds = [FlowElementType.CHAT.value, FlowElementType.REASONING.value, FlowElementType.RESULT.value]

    early = asyncio.create_task(_consume(handler))
    await asyncio.sleep(0)  # let the early consumer register its queue

    late = None
    for i in range(300):
        await handler.on_flow_data(_chat(f"chunk-{i} <&> ", kinds[(i // 7) % 3]))
        if i == 150:
            late = asyncio.create_task(_consume(handler))
            await asyncio.sleep(0)
    await handler.on_flow_data(None)

    early_text, late_text = await asyncio.gather(early, late)
    after_text = await _consume(handler)  # attaches after the end: history only

    assert early_text
    assert "chunk-299" in early_text
    assert late_text == early_text
    assert after_text == early_text
    assert handler.get_history() == early_text


async def test_history_is_not_copied_per_chunk():
    """Complexity guard without a clock: with a copy per append the peak while
    streaming is 2x the final history; collecting parts keeps it near 1x."""
    handler = StreamingResponseHandler()
    chunks = [f"{i:08d}" + "y" * 1016 for i in range(2000)]  # distinct 1 KB chunks

    tracemalloc.start(1)
    try:
        base = tracemalloc.get_traced_memory()[0]
        tracemalloc.reset_peak()
        for text in chunks:
            await handler.on_flow_data(_chat(text))
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    history_size = len(handler.get_history())
    assert history_size >= 2000 * 1024
    assert peak - base < 1.5 * history_size, f"peak {peak - base} vs history {history_size}"
