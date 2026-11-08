"""``AgentEnvEntry`` — one variable of an agent's Env (``agent.json`` → ``env``).

The agent's Env is what every deployment of it gets: each entry names a variable, says whether it is a
secret or plain, and whether the owner approved it for injection (``inject``). Only approved entries are
placed on a deployment's machine (by the hub); an unapproved one is kept on the agent and never placed.

A **secret** entry is a name only: its value lives in the agent's hub store (``agent/<id>/env-var``), write-only,
and never in this file. A **plain** entry carries its ``value`` here — it is not secret and is versioned with
the agent. Stdlib + pydantic only, like the rest of ``data_spec``.
"""

from __future__ import annotations

import re
from typing import ClassVar, Literal, Optional

from pydantic import ConfigDict, field_validator, model_validator

from flow_sdk.schema.data_spec.spec import DataSpec

ENV_KIND_SECRET = "secret"
ENV_KIND_PLAIN = "plain"

_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class AgentEnvEntry(DataSpec):
    """One variable of the agent's Env. A secret's value is never part of it."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "agent.env"

    #: The variable's name, as the box's environment reads it (``OPENWEATHER_API_KEY``).
    name: str
    kind: Literal["secret", "plain"] = ENV_KIND_SECRET
    description: str = ""
    #: The owner's approval: only an approved entry is injected into the agent's deployments.
    inject: bool = False
    #: A plain entry's value. Always ``None`` for a secret — a value here is dropped, never written.
    value: Optional[str] = None

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value: object) -> str:
        text = str(value or "").strip()
        if not _ENV_NAME.fullmatch(text):
            raise ValueError(f"an env name is letters, digits and _ and does not start with a digit, got {value!r}")
        return text

    @model_validator(mode="before")
    @classmethod
    def _secret_has_no_value(cls, value: object) -> object:
        if isinstance(value, dict) and value.get("kind", ENV_KIND_SECRET) == ENV_KIND_SECRET and "value" in value:
            value = {k: v for k, v in value.items() if k != "value"}
        return value

    def hub_entry(self) -> dict:
        """What ``PUT agent/<id>/env`` takes for this entry: a plain value rides along, a secret is its name."""
        entry: dict = {"name": self.name, "kind": self.kind, "description": self.description, "inject": self.inject}
        if self.kind == ENV_KIND_PLAIN and self.value is not None:
            entry["value"] = self.value
        return entry


def unique_entries(entries: list[AgentEnvEntry]) -> list[AgentEnvEntry]:
    """``entries`` with each name once — the last one written wins, in first-seen order."""
    by_name: dict[str, AgentEnvEntry] = {}
    for entry in entries:
        by_name[entry.name] = entry
    return list(by_name.values())


__all__ = ["ENV_KIND_PLAIN", "ENV_KIND_SECRET", "AgentEnvEntry", "unique_entries"]
