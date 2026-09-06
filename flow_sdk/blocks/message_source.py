"""Compatibility shim. The block moved to ``flow_sdk.blocks.message_block``.

``MessageSource`` now names the domain concept — a bidirectional ``DataSource``
(one with ``channel`` set whose driver declares ``sends=True``); see
``docs/glossary.md``. The process-local prompt/reply block that briefly carried
the name is ``MessageBlock``. This module keeps out-of-tree scripts importing
the old path working; new code imports from ``flow_sdk.blocks``.
"""

from .message_block import MessageBlock, MessageRequest

MessageSource = MessageBlock

__all__ = ["MessageRequest", "MessageSource"]
