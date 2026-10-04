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
(``list_llm_candidates(worker, ...)``). As a field it would yield an N x M cross-product
whose identity is ambiguous.

Stdlib + pydantic only, like the rest of ``data_spec`` — ``spec.py`` must stay
importable from ``flow_sdk/builtin/*`` with no cycle.
"""

from __future__ import annotations

from typing import Any, ClassVar

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


class LLMSourceRefusal(StrEnum):
    """WHY a source cannot fund this harness, as a code a surface can branch on.

    ``reason`` is the sentence, rendered verbatim; this is the same answer for code. A
    surface that needs to offer a fix ("Sign in", "Add key", "Install") reads the code and
    never parses the sentence -- parsing it is how a reworded message silently broke a button.
    """

    NOT_INSTALLED = "not_installed"
    SIGNED_OUT = "signed_out"
    LOGIN_NOT_CHECKED = "login_not_checked"
    LOGIN_FAILED = "login_failed"
    SIGNING_IN = "signing_in"
    NO_LOGIN = "no_login"
    NO_KEY = "no_key"
    HUB_SIGNED_OUT = "hub_signed_out"
    ENDPOINT_DISABLED = "endpoint_disabled"
    #: Another source is required (a process or project pin) or chosen (a stated preference).
    PINNED_ELSEWHERE = "pinned_elsewhere"


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
    #: The same refusal as a code (``LLMSourceRefusal``); empty when eligible.
    reason_code: str = ""
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
                f"{self.name or self.endpoint_typeid}: an eligible source must not carry a reason ({self.reason!r})"
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

    def ineligible(self, reason: str, code: "LLMSourceRefusal") -> "LLMSource":
        """This source, ruled out, carrying the sentence that says why.

        The overlay builds a rejected list by mapping this over the inventory, so a
        constraint is expressed ON the list rather than beside it -- which is what makes
        the list self-explaining and lets a spawn error be a rendering of it."""
        return self.model_copy(update={"eligible": False, "auto": False, "reason": reason, "reason_code": code.value})


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


class FundingBindingSpec(DataSpec):
    """The hub endpoint this box was bound to -- one object, not six top-level fields."""

    spec_kind: ClassVar[str] = "funding.binding"

    endpoint_typeid: str
    invoke_path: str = ""
    invoke_url: str = ""
    provider: str = ""
    name: str = ""
    #: A PUBLIC endpoint: spendable with no hub login (the id is the bearer).
    public: bool = False


class DefaultFundingSpec(DataSpec):
    """Is the box SET UP: what funds the harness a person is about to run (the user's default).

    The one place that rule is decided, so the CLI's `auto`, the chooser, the startup gate, the
    warnings and readiness cannot answer it differently. An INSTALLED default is set up only when
    it is funded. A default that is not installed can be funded by nothing, so then any funded
    harness answers -- first-run setup settles funding before it installs the default.
    """

    spec_kind: ClassVar[str] = "funding.default"

    #: Capability kind of the default harness (``""`` when none is recorded).
    kind: str = ""
    installed: bool = False
    #: The source that answers, ``None`` when nothing does.
    source: LLMSource | None = None
    #: Why nothing answers, when ``source`` is None.
    reason: str = ""


class DecisionApiSpec(DataSpec):
    """Can this box take fast decisions: is there a hub ``APIEndpoint`` marked ``decision``.

    Box-wide, not per harness -- a decision is not a harness turn. When it is not available the
    navigator is off and every ask takes the ordinary agent path, so ``reason`` is a fact to
    show, never an error.
    """

    spec_kind: ClassVar[str] = "funding.decision"

    available: bool = False
    #: The endpoint ``decide()`` would use, as ``api_endpoint-<id>``.
    endpoint: str = ""
    name: str = ""
    #: The vendor host it fronts (``api.typesafe.ai``).
    host: str = ""
    #: Why not, when ``available`` is False.
    reason: str = ""


class FundingStatusSpec(DataSpec):
    """What funds each harness, layered ON TOP of the status record (``core.status``).

    Funding facts only. Whether a CLI is installed or signed in, which keys are stored and
    whether FlowPad is signed in are STATUS facts and live in ``StatusSpec``; this record
    answers, per harness, which source pays and -- when none can -- why.
    """

    spec_kind: ClassVar[str] = "funding.status"

    #: Per harness (capability kind): every source it HAS, each judged on its own credential.
    sources: dict[str, list[LLMSource]]
    #: Per harness: the source a spawn would actually spend, or None.
    resolved: dict[str, LLMSource | None]
    #: Per harness: when ``resolved`` is None, the top-ranked refusal, verbatim.
    blocked: dict[str, str]
    #: Per harness: a stated preference that is not in force, and why.
    notes: dict[str, str]
    #: The endpoint rows the verdicts name (wire form), keyed by endpoint typeid.
    endpoints: dict[str, dict[str, Any]]
    #: Every hub endpoint this user could be pointed at (wire form, with admin flags).
    available: list[dict[str, Any]]
    #: Harness kinds whose resolved source IS the bound endpoint.
    active_for: list[str]
    binding: FundingBindingSpec | None = None
    default: DefaultFundingSpec = DefaultFundingSpec()
    #: The decision API (box-wide): what answers a fast decision, or why nothing does.
    decision: DecisionApiSpec = DecisionApiSpec()
