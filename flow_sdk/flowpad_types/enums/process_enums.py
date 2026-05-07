from enum import Enum


class ProcessType(str, Enum):
    """Discriminates how an AgenticProcess is being used.

    - CHAT: conversational process attached to an editor surface (chat about
      this doc; populated by the side-drawer Chat tab).
    - EXECUTION: process that executes an embedded asset (agent / skill) or
      runs a workflow / runs an asset on a doc.
    """

    CHAT = "chat"
    EXECUTION = "execution"
