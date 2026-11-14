"""A machine's IT reply is not a "new message": it arrives read, and the bridge raises no notification for a
message that carries ``it_reply``."""

from flow_sdk.builtin.flow_message import FlowMessage, derive_it_reply


def test_a_machine_reply_arrives_read_and_the_request_does_not():
    reply, request = FlowMessage(text="done"), FlowMessage(text="run the class report")
    derive_it_reply(reply, {"metadata": {"it": {"node_typeid": "node.id.1", "state": "done"}}})
    # The owner's own request carries ``metadata.it`` too, but names no node.
    derive_it_reply(request, {"metadata": {"it": {"send_id": "s1", "op_id": "o1"}}})
    assert reply.is_read and reply.it_reply
    assert not request.is_read and not request.it_reply
