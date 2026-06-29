from enum import Enum


class ProcessKind(str, Enum):
    """Discriminates how an AgenticProcess is being used.

    - CHAT: conversational process attached to an editor surface (chat about
      this doc; populated by the side-drawer Chat tab).
    - EXECUTION: process that executes an embedded asset (agent / skill) or
      runs a workflow / runs an asset on a doc.
    - ANALYSIS: child process that analyzes another process's worker session
      (agent-trace). Paired with the analyzed process: parent_type_id points at
      it and each is in the other's private context.
    - CONVERSATION: the single live worker session that owns a Conversation;
      the conversation header's Open button targets it, and its absence is what
      surfaces the launch toolbar.
    """

    CHAT = "chat"
    EXECUTION = "execution"
    ANALYSIS = "analysis"
    CONVERSATION = "conversation"

# Deprecated alias — renamed to ProcessKind (2026-06-12). Remove after one release.
ProcessType = ProcessKind
