"""``LLMSource`` — the one shape for "where a worker's tokens come from".

A FlowPad worker is funded exactly three ways, and before this type they were three
unrelated things: a vendor device login (no representation at all — the resolver
returned ``None`` to mean it), a stored provider key (a ``LMApiProvider`` value), and a
hub ``LLMEndpoint`` (modelled as *a provider whose key happens to be the hub login*).
That collapse is why every consumer re-derived "which of the three is active", each
slightly differently. One value type, so a funding decision can be ranked, logged,
stamped on a turn, and — above all — EXPLAINED.

``reason`` is the product, not a debug aid. A source that cannot fund this worker comes
back ineligible carrying the sentence that says why, and both the picker and the spawn
error render that sentence verbatim. Nothing above this layer authors its own
ineligibility text, because a second author is a second source of truth and the two
drift (exactly how a stale ``login_state`` once told users their working harness was
signed out).

Three fields exist because one boolean cannot carry what callers need:

* ``eligible`` — may this fund a spawn at all;
* ``auto`` — may it be chosen WITHOUT being asked for. A user with five endpoints has
  five eligible sources and one that should be picked silently;
* ``authority`` — how much the answer is worth. A probed device login is evidence; a
  hub endpoint we merely believe is reachable is not the same claim, and a caller that
  cannot tell them apart will treat an assumption as a fact.

**Identity is the endpoint** — see ``ref``. Every funding source is an ``LLMEndpoint``
now (kind ``device`` / ``api_key`` / ``hub``), so this type carries no identity of its own:
it names one and adds the verdict. It used to duplicate ``kind``/``provider`` because a
stored key had no row to point at; it does now. What a process or project *stores* is the
endpoint typeid; storing a serialized source would freeze transient status into a
persisted row.

This stays a separate value rather than fields on the endpoint because a verdict is
**per harness**, and the endpoint is not. The same stored OpenRouter key is eligible for
one harness and refused by another whose spec does not accept its provider, so the box
status screen holds several verdicts naming the same endpoint id at once. Folded onto the
row, ``eligible`` would have no answer without knowing which list it came from — and the
row is the one thing here that is durable and saveable.

The harness is deliberately NOT a field. Device login is per-harness by definition, a
key is only usable by harnesses whose spec accepts its provider, and an endpoint only by
harnesses that have a hub binding — so the harness is a *parameter* of the producer
(``list_llm_sources(worker, ...)``). As a field it would yield an N x M cross-product
whose identity is ambiguous.

Stdlib + pydantic only, like the rest of ``data_spec`` — ``spec.py`` must stay
importable from ``flow_sdk/builtin/*`` with no cycle.
"""

from __future__ import annotations

from typing import ClassVar

from pydantic import model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec


class LLMSourceKind(StrEnum):
    """What kind of thing pays for the tokens."""

    #: The vendor CLI's own OAuth credentials, on this machine.
    DEVICE = "device"
    #: A provider key the user stored (``lm_api.<provider>`` in the sod).
    API_KEY = "api_key"
    #: A hub ``LLMEndpoint`` — a budget, spent with the hub login key.
    ENDPOINT = "endpoint"


class LLMSourceAuthority(StrEnum):
    """How good the eligibility answer is. Never flatten these into ``eligible``."""

    #: Something authoritative was asked and answered (a vendor probe said logged-in).
    PROVEN = "proven"
    #: Read from a cache that is stale by construction -- nothing invalidates a
    #: ``login_state`` when the user signs out of the CLI in a terminal.
    CACHED = "cached"
    #: Locally unknowable; the authority is elsewhere. A hub endpoint's chain may have
    #: no credentialed root, and only the hub finds out -- at invoke time.
    PRESUMED = "presumed"


class LLMSourceOrigin(StrEnum):
    """Which rung of the resolution ladder produced this verdict."""

    #: ``AgenticProcess.llm_endpoint_typeid`` -- this process was told to spend it.
    PROCESS = "process"
    #: ``Project.llm_endpoint_typeid`` -- the project enforces it.
    PROJECT = "project"
    #: The user's stated preference (``Capability.auth_mode`` / ``api_provider``).
    USER = "user"
    #: Nothing asked for it; it won the default order.
    DEFAULT = "default"


class LLMSource(DataSpec):
    """One way this harness could be funded, and whether it can be. Frozen: a value."""

    spec_kind: ClassVar[str] = "llm.source"

    #: The endpoint this verdict is about — ``llm_endpoint-<uuid>``, always set. Look the
    #: row up for anything else you need (kind, provider, base URL, model slugs); this type
    #: deliberately mirrors none of it.
    endpoint_typeid: str
    name: str = ""
    #: Secondary display line -- a masked key hint, a sign-in caveat, and so on. Display
    #: ONLY: never a credential, and never branched on. Anything a caller must decide from
    #: gets its own field, so improving a label cannot change behaviour.
    detail: str = ""
    eligible: bool = False
    #: Why not, when not -- and ONLY when not; an eligible source has no reason. Rendered
    #: verbatim by every consumer, so a caveat carried here on a usable source surfaces as
    #: that source's status message. Caveats belong in ``detail``. Enforced below.
    reason: str = ""
    auto: bool = False
    authority: LLMSourceAuthority = LLMSourceAuthority.PRESUMED
    #: Position in the preference order; lower is preferred. Meaningless across kinds
    #: of different harnesses, which is why the producer is per-harness.
    rank: int = 0
    origin: LLMSourceOrigin = LLMSourceOrigin.DEFAULT

    @model_validator(mode="after")
    def _reason_only_when_ineligible(self):
        """``reason`` explains a refusal, so an eligible source must not carry one."""
        if self.eligible and self.reason:
            raise ValueError(
                f"{self.name or self.endpoint_typeid}: an eligible source must not carry a "
                f"reason ({self.reason!r})"
            )
        if not self.endpoint_typeid:
            raise ValueError("an LLMSource must name the endpoint it is a verdict about")
        return self

    @property
    def ref(self) -> str:
        """This source's identity: the endpoint it names.

        Was a ``(kind, provider, typeid)`` tuple back when a stored key had no row and the
        tuple was the only way to say which source this was.
        """
        return self.endpoint_typeid

    def ineligible(self, reason: str) -> "LLMSource":
        """This source, ruled out, carrying the sentence that says why.

        The overlay builds a rejected list by mapping this over the inventory, so a
        constraint is expressed ON the list rather than beside it -- which is what makes
        the list self-explaining and lets a spawn error be a rendering of it."""
        return self.model_copy(update={"eligible": False, "auto": False, "reason": reason})


class LLMScope(DataSpec):
    """What a funding question is being asked ABOUT — the two hard rungs, as a value.

    The ladder's top two rungs are constraints imposed by something that owns the spawn: the
    process was told to spend an endpoint, or the project it belongs to enforces one. Both are
    just an endpoint typeid plus who required it, so they collapse into one small value.

    It exists so the SPAWN and the PICKER can ask the same question. They could not before:
    the resolver's constraint rung read the two fields off an ``AgenticProcess``, so the box
    status screen — which has no process to hand it — silently skipped rungs 1 and 2 and
    answered as if no project had ever pinned anything. A screen that cannot express the
    constraint cannot show it, and the picker and the spawn disagreed by construction.

    A *scope*, not a process: the picker's scope is a project alone, and demanding a process
    would have meant either inventing a fake one or forking the resolver. Empty means the
    box-wide question — no constraint, rungs 3 and 4 only — which is exactly what a caller
    with nothing to say should produce.

    Frozen and ``extra="forbid"`` from :class:`DataSpec`, like every value here.
    """

    #: ``AgenticProcess.llm_endpoint_typeid`` — rung 1. Beats the project's.
    process_llm_endpoint_typeid: str = ""
    #: The project whose ``llm_endpoint_typeid`` is rung 2. The id, not the typeid: it is
    #: looked up, and ``_constraint`` is the only thing that reads the field off the row.
    project_id: str = ""
    #: Whose scope this is, for the ancestor walk a process falls back to when it carries no
    #: ``project_id`` of its own (embedded and inline processes legitimately do not). Empty
    #: for a project-only scope, which names its project outright and has nothing to walk
    #: from — so the fallback simply does not apply there.
    owner_typeid: str = ""

    @classmethod
    def of_process(cls, process) -> "LLMScope":
        """The scope a spawn asks in. Duck-typed on purpose — ``AgenticProcess`` lives in
        ``builtin`` and importing it here would be the cycle this module exists to avoid."""
        return cls(
            process_llm_endpoint_typeid=str(getattr(process, "llm_endpoint_typeid", "") or ""),
            project_id=str(getattr(process, "project_id", "") or ""),
            owner_typeid=str(getattr(process, "typeid", "") or ""),
        )

    @classmethod
    def of_project(cls, project_id: str | None) -> "LLMScope":
        """The scope a project-aware picker asks in: rung 2 only."""
        return cls(project_id=str(project_id or ""))
