"""``FlowCommandEntry`` — an agent driving Flowpad through the ``flow`` CLI.

A **derived** entry: nothing parses it out of a raw transcript line. It is a
refinement of an already-parsed shell command (Claude ``Bash``, Codex
``shell``, Copilot ``bash``) whose text invokes the ``flow`` CLI — see
:mod:`flow_sdk.transcript_analyzer.derive`. Subclassing
:class:`ShellCommandEntry` keeps command / exit_code / stdout available to
every existing consumer; the extra fields let the UI render a chip that opens
whatever the command targeted.
"""

from __future__ import annotations

from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

from ..entry import EntryKind
from .shell_command import ShellCommandEntry


class FlowCommandEntry(ShellCommandEntry):
    kind = EntryKind.FLOW_COMMAND

    def __init__(
        self,
        *,
        verb: str,
        subverb: str | None = None,
        target: str | None = None,
        flow_args: list[str] | None = None,
        **base: Any,
    ) -> None:
        super().__init__(**base)
        # ``flow show entity <typeid>`` → verb='show', subverb='entity',
        # target='<typeid>'. ``flow record --type task`` → verb='record',
        # subverb=None, target=None.
        self.verb = verb
        self.subverb = subverb
        self.target = target
        self.flow_args = flow_args or []

    def to_flow_data(self) -> list[FlowData]:
        frames = super().to_flow_data()
        for fd in frames:
            fd.attributes["flow-verb"] = self.verb
            if self.subverb:
                fd.attributes["flow-subverb"] = self.subverb
            if self.target:
                fd.attributes["flow-target"] = self.target
            if isinstance(fd.flow_value, dict):
                fd.flow_value["flow_verb"] = self.verb
                fd.flow_value["flow_subverb"] = self.subverb
                fd.flow_value["flow_target"] = self.target
        return frames

    def to_dict(self) -> dict:
        return {
            **super().to_dict(),
            "verb": self.verb,
            "subverb": self.subverb,
            "target": self.target,
            "flow_args": self.flow_args,
        }

    def _body_lines(self) -> list[str]:
        out = [f"verb: {self.verb}"]
        if self.subverb:
            out.append(f"subverb: {self.subverb}")
        if self.target:
            out.append(f"target: {self.target}")
        out.extend(super()._body_lines())
        return out
