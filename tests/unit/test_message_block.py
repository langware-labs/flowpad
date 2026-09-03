from __future__ import annotations

import asyncio

import pytest
from pydantic import ValidationError

from flow_sdk.blocks import MessageBlock
from flow_sdk.schema.data_spec.spec import DataSpec


@pytest.mark.asyncio
async def test_simple_source_sends_a_prompt_and_returns_its_reply() -> None:
    channel = MessageBlock.get("simple")

    async with channel.listen() as messages:

        async def respond_once() -> None:
            message = await anext(messages)
            assert message.text == "Where is the treasure?"
            assert message.body == message.text
            assert message.name == ""
            assert message.thread_key
            assert message.external_id
            assert isinstance(message, DataSpec)
            assert message.model_dump() == {
                "text": "Where is the treasure?",
                "thread_key": message.thread_key,
                "external_id": message.external_id,
            }
            await message.reply("Under the old oak.")

        _, reply = await asyncio.gather(
            respond_once(),
            channel.send("Where is the treasure?"),
        )

    assert reply == "Under the old oak."


@pytest.mark.asyncio
async def test_each_concurrent_send_receives_its_own_reply() -> None:
    channel = MessageBlock.get("simple")

    async with channel.listen() as messages:

        async def respond() -> None:
            first = await anext(messages)
            second = await anext(messages)
            await second.reply(f"reply to {second.text}")
            await first.reply(f"reply to {first.text}")

        _, first_reply, second_reply = await asyncio.gather(
            respond(),
            channel.send("first"),
            channel.send("second"),
        )

    assert first_reply == "reply to first"
    assert second_reply == "reply to second"


@pytest.mark.asyncio
async def test_send_requires_an_active_listener() -> None:
    channel = MessageBlock.get("simple")

    with pytest.raises(RuntimeError, match="no active listener"):
        await channel.send("hello")


@pytest.mark.asyncio
@pytest.mark.parametrize("prompt", ["", "   "])
async def test_send_rejects_a_blank_prompt(prompt: str) -> None:
    channel = MessageBlock.get("simple")

    async with channel.listen():
        with pytest.raises(ValueError, match="cannot be blank"):
            await channel.send(prompt)


@pytest.mark.asyncio
async def test_only_one_listener_can_be_active() -> None:
    channel = MessageBlock.get("simple")

    async with channel.listen():
        with pytest.raises(RuntimeError, match="already has an active listener"):
            async with channel.listen():
                pass


@pytest.mark.asyncio
async def test_a_request_can_be_replied_to_only_once() -> None:
    channel = MessageBlock.get("simple")

    async with channel.listen() as messages:
        send = asyncio.create_task(channel.send("hello"))
        message = await anext(messages)
        await message.reply("hi")
        assert await send == "hi"

        with pytest.raises(RuntimeError, match="no longer awaiting"):
            await message.reply("again")


@pytest.mark.asyncio
async def test_request_round_trips_without_copying_its_reply_capability() -> None:
    channel = MessageBlock.get("simple")

    async with channel.listen() as messages:
        send = asyncio.create_task(channel.send("hello"))
        message = await anext(messages)
        copies = (
            type(message).model_validate(message.model_dump()),
            message.model_copy(),
            message.model_copy(deep=True),
        )

        for copy in copies:
            assert copy == message
            assert copy.model_dump() == message.model_dump()

        await copies[-1].reply("hi")
        assert await send == "hi"
        with pytest.raises(RuntimeError, match="no longer awaiting"):
            await message.reply("second reply")


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["text", "body", "name", "thread_key", "external_id"])
async def test_request_fields_are_read_only_without_breaking_correlation(field: str) -> None:
    channel = MessageBlock.get("simple")

    async with channel.listen() as messages:
        send = asyncio.create_task(channel.send("hello"))
        message = await anext(messages)
        with pytest.raises((AttributeError, ValidationError)):
            setattr(message, field, "changed")
        await message.reply("hi")
        assert await send == "hi"


@pytest.mark.asyncio
async def test_listener_exit_fails_an_unresolved_send() -> None:
    channel = MessageBlock.get("simple")

    async with channel.listen() as messages:
        send = asyncio.create_task(channel.send("hello"))
        await anext(messages)

    with pytest.raises(RuntimeError, match="closed before replying"):
        await send


def test_each_get_returns_a_fresh_block() -> None:
    assert MessageBlock.get("simple") is not MessageBlock.get("simple")


def test_unknown_block_kind_is_rejected() -> None:
    with pytest.raises(ValueError, match="Unknown message block kind"):
        MessageBlock.get("missing")
