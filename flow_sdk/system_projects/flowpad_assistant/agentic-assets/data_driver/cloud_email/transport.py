"""``AppMailbox`` — an agent's hub mailbox as the cloud email source reaches it on this machine.

The agent-mailbox driver family and the ordinary cloud login, with its failures as the contract errors
that decide polling. Built by ``CloudEmailSource.build``; a test hands the source its own.
"""
from __future__ import annotations


class AppMailbox:
    """The ``MailboxTransport`` a cloud email source is built over."""

    async def list_messages(self, agent_id, **filters):
        return await self._call("list_messages", agent_id, **filters)

    async def get_message(self, agent_id, message_id):
        return await self._call("get_message", agent_id, message_id)

    async def send(self, agent_id, body):
        return await self._call("send", agent_id, body)

    async def reply(self, agent_id, message_id, body):
        return await self._call("reply", agent_id, message_id, body)

    @staticmethod
    async def _call(verb, *args, **kwargs):
        from flow_sdk.builtin.agent_mailbox_driver import AgentMailboxError, get_agent_mailbox_driver  # noqa: PLC0415

        try:
            return await getattr(get_agent_mailbox_driver(), verb)(*args, **kwargs) or {}
        except AgentMailboxError as exc:
            raise mailbox_refusal(exc) from exc


def mailbox_refusal(exc):
    """A mailbox failure as the contract error. Two cases the status table cannot know: no status at
    all (a backend not configured needs a person; a transport failure needs the next tick), and a
    404, which on this route means the agent has no mailbox — re-provisioning is a human act."""
    from flow_sdk.sources import http  # noqa: PLC0415
    from flow_sdk.sources.errors import NotFound, Rejected, SourceUnavailable  # noqa: PLC0415

    reason = str(getattr(exc, "reason", "") or "")
    status = int(getattr(exc, "status_code", 0) or 0)
    if status == 0:
        if "not configured" in reason:
            return Rejected(f"The agent mailbox backend is not configured on this instance ({reason}).")
        return SourceUnavailable(f"the mailbox could not be reached: {reason}")
    if status == 404:
        return NotFound(reason or "This agent has no mailbox.")
    return http.error_for_status(status, reason)


__all__ = ["AppMailbox", "mailbox_refusal"]
