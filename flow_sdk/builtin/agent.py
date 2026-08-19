"""Agent — the launchable agent: identity + launch bundle.

An Agent answers *who*; a ``Deployment`` answers *where and how*; an
``AgenticProcess`` records *what happened on one run*::

    Agent.deploy()       -> Deployment        (kind ``runtime.agent``)
    Deployment.launch()  -> AgenticProcess

Folder layout (``AssetClass.REPO``, like Spec/Task/Deck)::

    <scope>/agentic-assets/agent/<name>/agent.md

The entity OWNS that file (``owns_main_ref``): ``system_prompt`` is the
authoring surface and the body is re-rendered on every save, so disk stays the
source of truth (``docs/CLAUDE.md`` §1) while the hub copy still carries the
prompt as a real field.

NOT the same thing as a ``SubAgent``: that is the provider-owned
``.claude/agents/<name>.md`` prompt asset Claude Code reads directly. An Agent
may *reference* SubAgents through ``subagents`` — they render to that path
verbatim and are never absorbed here.
"""
from typing import TYPE_CHECKING, ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.deployment import KIND_AGENT, Deployment
from flow_sdk.core import Entity, action
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgentOptions

#: The two vocabularies for "which CLI".
#:
#: An agent.md declares the DRIVER short-id — that is what a human writes, what
#: the CLI is called, and the key ``cli_drivers.factory`` dispatches on. But
#: ``AgenticProcess.worker_type`` is a ``WorkerType``, whose Claude member is
#: ``claude_code``. Feed one where the other is expected and the process fails
#: pydantic validation, which is exactly what a real launch found.
#:
#: The forward direction is NOT redefined here: ``get_driver`` already owns that
#: alias table, and owns it better — it also handles ``claude_code_cli``, a
#: ``WorkerType`` object, casing, and the ``FLOWPAD_DEFAULT_WORKER`` default.
#: A private copy would be the fourth in the tree and would silently ignore that
#: env override.

def driver_key(worker: str | None) -> str:
    """The ``cli_drivers.factory`` key for either vocabulary."""
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (  # noqa: PLC0415
        get_driver,
    )

    # A blank `worker_type:` in an agent.md means "unset", but get_driver only
    # treats None as unset and would raise on "". Normalize before handing over.
    return get_driver((worker or "").strip() or None).name


def worker_type_value(worker: str | None) -> str:
    """The ``AgenticProcess.worker_type`` enum value for either vocabulary.

    No production helper does this direction — only test-local copies — so it
    lives here, derived from ``driver_key`` so the two can't disagree.
    """
    # `driver_key` can only return claude/codex/copilot (get_driver raises on
    # anything else), and only claude's names differ between the two vocabularies.
    key = driver_key(worker)
    return "claude_code" if key == "claude" else key


class Agent(Entity):
    type: str = APIField(default=EntityType.AGENT.value)

    # ── identity / presentation ───────────────────────────────────────────
    # `name` / `title` / `uname` come from Entity. `name` is the addressable
    # slug: get_agent_local_deployment("asset-cleanup") resolves on it.
    description: str = APIField(default="", description="One-line purpose, shown on the agent card.")
    avatar: Optional[str] = APIField(default=None, description="Emoji or image ref — presentation only.")
    system_prompt: str = APIField(
        default="",
        description="Who this agent is. Delivered through context_data.instructions — the channel "
        "resolve_system_instructions reads — so it reaches all three vendors and never enters "
        "cli_config, leaving the restart hash untouched.",
    )

    # ── launch bundle (projected into AgentOptions at launch) ─────────────
    worker_type: Optional[str] = APIField(default=None, description="claude | codex | copilot.")
    model: Optional[str] = APIField(default=None, description="Tier (sm/md/lg) or a concrete model id.")
    permission_mode: Optional[str] = APIField(default=None)
    effort: Optional[str] = APIField(default=None)
    # ── DECLARED ONLY, not yet enforced ───────────────────────────────────
    # These round-trip through agent.md and are visible on the agent's card,
    # but `to_agent_options` cannot project them: no AgentOptions subclass has
    # a field to carry them, so nothing reaches the worker. Do not present them
    # in a UI as if they gated anything until that lands.
    max_turns: Optional[int] = APIField(default=None)
    tools: Optional[list[str]] = APIField(default=None)
    disallowed_tools: Optional[list[str]] = APIField(default=None)
    skills: list[TypeId] = APIField(default_factory=list)
    mcp_servers: list[TypeId] = APIField(default_factory=list)
    subagents: list[str] = APIField(
        default_factory=list,
        description="SubAgent NAMES this agent may delegate to. Names, not TypeIds, because a "
        "shipped agent.md is authored before the SubAgent it references has ever been indexed. "
        "DECLARED ONLY — nothing projects these into --agents yet; wire through "
        "AgenticProcess.load_embedded_subagent(name) when a caller needs it.",
    )
    additional_dirs: list[str] = APIField(default_factory=list)
    load_flowpad_assistant: bool = APIField(default=False)
    cli_options: dict = APIField(
        default_factory=dict,
        description="Vendor-specific launch keys the schema does not enumerate (e.g. Claude's "
        "`chrome: true`). Merged into the options bundle under the named fields, so a "
        "capability an agent needs stays visible on its card instead of living at a call site.",
    )

    # ── email ─────────────────────────────────────────────────────────────
    #
    # The mailbox itself is NOT pointed at from here — `EmailInbox.agent_typeid`
    # is the authoritative link, and the hub's own notes give the reason (a
    # pointer field would duplicate drift-prone state and foreclose an agent
    # holding several inboxes). What lives here is POLICY, which is ours: who
    # may drive this agent by mail.
    #
    # On the Agent rather than the Deployment because the hub allocates one
    # inbox per AGENT. The same agent deployed to `local` and to `e2b` shares a
    # single address, so a per-placement policy would let two rows disagree
    # about who may write to one mailbox.
    email_enabled: bool = APIField(
        default=False,
        description="Whether inbound mail to this agent's mailbox may drive it.",
    )
    #: Addresses permitted to drive this agent. **Empty means nobody** — closed,
    #: not open. The address is public, permanent and publicly writable, so the
    #: default that cannot leak an agent holding tools is the safe one.
    #:
    #: PRIVATE: these are third parties' personal addresses and have no business
    #: on a receiver or on the hub.
    email_allowed_senders: list[str] = APIField(
        default_factory=list,
        sharing=Sharing.PRIVATE,
        description="Addresses allowed to drive this agent by email; empty allows none.",
    )

    def may_email(self, address: str) -> bool:
        """Whether *address* is permitted to drive this agent.

        Case- and whitespace-insensitive: an address is an identifier a human
        types, and `Alice@Example.com ` is the same correspondent as
        `alice@example.com`. Nothing normalizes on the way in, so it happens
        here — the one place the comparison is made.
        """
        if not self.email_enabled:
            return False
        candidate = (address or "").strip().lower()
        if not candidate:
            return False
        return any(candidate == (a or "").strip().lower() for a in self.email_allowed_senders)

    # ── lifecycle ─────────────────────────────────────────────────────────
    enabled: bool = APIField(default=True, description="Kill switch — a disabled agent refuses to launch.")
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)

    _api_visible: ClassVar[bool] = True

    # ── deployment ────────────────────────────────────────────────────────

    async def deploy(self, provider: str = "local") -> Deployment:
        """Idempotent upsert of this agent's placement on *provider*.

        Converges through ``Deployment.find_existing`` rather than a derived id:
        the row keeps whatever v4 it was first minted with, forever, on every
        tier that holds it.
        """
        from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        machine = get_instance_settings().instance_name
        return await Deployment.upsert(
            parent_type_id=str(self.typeid),
            provider=provider,
            kind=KIND_AGENT,
            element=self,
            payload={
                "name": f"{self.name or self.id} ({provider})",
                "target": {
                    "provider": provider,
                    "scope": self.project_id or "machine",
                    "location": machine,
                },
                "origin": {
                    "kind": provider,
                    "provider": provider,
                    # The machine it runs on. `local` is, by definition, this
                    # one; other providers pass their own node when the placement
                    # is created for them.
                    "external_id": ComputeNode._local_id() if provider == "local" else "",
                },
                "status": {"sync_state": "current", "provider_state": "configured"},
                "provider_labels": {
                    "flowpad.agent.name": str(self.name or ""),
                    "flowpad.agent.worker": str(self.worker_type or ""),
                    "flowpad.agent.model": str(self.model or ""),
                },
                "project_id": self.project_id,
            },
        )

    async def local_deployment(self) -> Deployment:
        """Get-or-create the placement that runs this agent on THIS machine."""
        return await self.deploy("local")

    async def deployments(self) -> list[Deployment]:
        rows = await Deployment.get_all({"match": {"parent_type_id": str(self.typeid)}})
        return [row.with_element(self) for row in rows]

    # ── publish ───────────────────────────────────────────────────────────

    async def ensure_on_hub(self, actor: TypeId) -> bool:
        """Publish this repository-backed agent through the canonical Git path.

        An Agent is not a loose deployment payload. It is an asset inside its
        owning Project's repository, so publication must commit that asset path,
        push it, and register its ``GitOrigin`` under the already-published
        Project. The Hub can then clone the whole repository into the sandbox.

        ``remote=True`` without ``git_origin`` is legacy partial state produced by
        the old field-only share path. Treat it as unpublished so the next deploy
        repairs the row rather than preserving a deployment that cannot load its
        files (notably ``avatar.png``).
        """
        if self.remote and self.git_origin:
            return False

        from flow_sdk.assets._publish_service import owning_project  # noqa: PLC0415
        from flow_sdk.assets.git_publish import publish_git_asset  # noqa: PLC0415

        project = await owning_project(self)
        if project is not None:
            await project.ensure_on_hub()
        await publish_git_asset(self, actor)
        return True

    @action.post(action_name="publish")
    async def publish_action(self):
        """`POST /agent/<id>/publish` — commit, push, and register this agent."""
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        request_info = get_current_request_info()
        actor = request_info.someone_typeid if request_info else None
        if not actor:
            return ApiFailResponse(message="publish requires an authenticated user", status_code=401)
        try:
            published = await self.ensure_on_hub(actor)
        except Exception as exc:
            return ApiFailResponse(message=f"publish failed: {exc}")
        return ApiSuccessResponse(
            data={"agent_id": self.id, "published": published, "already_on_hub": not published}
        )

    # ── the mailbox ───────────────────────────────────────────────────────

    async def provision_inbox(self, actor: TypeId, **options) -> dict:
        """Give this agent an email address of its own.

        Publish is implicit for the same reason it is on ``deploy_to_cloud``: the
        mailbox hangs off the agent's row at the backend, so that row has to
        exist before anything can be allocated against it. ``ensure_on_hub`` is a
        no-op for an already-published agent.

        **Adopt before allocating.** An agent that already has an active mailbox
        gets that one back — never a second address. This is not just tidiness:
        an address is billable and permanent, and callers retry (the UI creates
        the DataSource in a second step, which can fail). Idempotence is what
        makes that retry safe, and it is enforced on both sides — here, and again
        at the backend.
        """
        from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver  # noqa: PLC0415

        await self.ensure_on_hub(actor)
        driver = get_email_inbox_driver()

        existing = await driver.get_inbox(self.id)
        if existing:
            return {"inbox": existing, "already_allocated": True}
        return {"inbox": await driver.create_inbox(self.id, **options), "already_allocated": False}

    @action.post(action_name="provision_inbox")
    async def provision_inbox_action(self):
        """`POST /agent/<id>/provision_inbox` — allocate (or adopt) its mailbox.

        Declares NO parameters. This module carries ``from __future__ import
        annotations`` and the dispatcher resolves an annotated ``request`` by
        identity, so an annotated parameter would 400 at runtime while every
        direct-call test still passed.
        """
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        request_info = get_current_request_info()
        actor = request_info.someone_typeid if request_info else None
        if not actor:
            return ApiFailResponse(
                message="provisioning a mailbox requires an authenticated user", status_code=401
            )
        body = await request_info.get_post_data() or {}
        options = {k: v for k, v in (body or {}).items() if k in ("username", "display_name")}
        try:
            result = await self.provision_inbox(actor, **options)
        except Exception as exc:  # noqa: BLE001 — surfaced as a message, not a 500
            return ApiFailResponse(message=f"could not provision a mailbox: {exc}")
        return ApiSuccessResponse(data={"agent_id": self.id, **result})

    async def decommission_inbox(self) -> bool:
        """Release this agent's address. False when it had none.

        Deliberately NOT called from ``delete()``: the address is the agent's
        public identity, and dropping it is a decision with consequences outside
        this machine (mail to it starts bouncing). It stays an explicit verb.
        """
        from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver  # noqa: PLC0415

        return await get_email_inbox_driver().delete_inbox(self.id)

    # ── deploy to the cloud ───────────────────────────────────────────────

    async def deploy_to_cloud(self, actor: TypeId) -> dict:
        """Give this agent a machine of its own on the hub.

        Publish is implicit: a deploy names an agent the hub has to already
        know, so ``ensure_on_hub`` runs first and the two are never separately
        orderable by a caller.

        The hub does everything else — it mints the ComputeNode, provisions the
        Identity, and logs the sandbox in AS the agent. Deliberately no
        parameters: were the node or the principal passable from here they would
        be passable from anywhere, which is the exact hole the hub's pentest
        guards exist to keep shut. This call says only *which agent*.

        The credentials live in this process, so the browser never talks to the
        hub directly.
        """
        from flow_sdk.builtin.cloud_deploy import deploy_entity_to_cloud  # noqa: PLC0415

        await self.ensure_on_hub(actor)
        return await deploy_entity_to_cloud(self)

    @action.post(action_name="deploy")
    async def deploy_action(self):
        """`POST /agent/<id>/deploy` — publish, then boot a box for this agent.

        One round trip for the UI's one button. Long by nature (E2B create +
        boot + health is tens of seconds); if that becomes a timeout in
        practice the fix is 202-and-poll on the node's ``ops/status``, which
        already exists, not a longer client timeout.
        """
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        if not self.enabled:
            return ApiFailResponse(message=f"agent {self.name!r} is disabled")
        request_info = get_current_request_info()
        actor = request_info.someone_typeid if request_info else None
        if not actor:
            return ApiFailResponse(message="deploy requires an authenticated user", status_code=401)
        from flow_sdk.assets.git_publish import (  # noqa: PLC0415
            AssetPublishError,
            publish_failure_status,
        )

        try:
            data = await self.deploy_to_cloud(actor)
        except AssetPublishError as exc:
            # Deploy publishes the agent through git first, so every publish
            # precondition is a deploy precondition. These are the caller's
            # state, not a server fault — reporting them as 500 both mislabels
            # them in logs and loses the sentence that says what to do.
            return ApiFailResponse(
                status_code=publish_failure_status(exc.code),
                message=exc.actionable,
                data={"code": str(exc.code), **exc.data},
            )
        except Exception as exc:
            return ApiFailResponse(message=f"deploy failed: {exc}")
        return ApiSuccessResponse(data={"agent_id": self.id, **data})

    # ── the run verb (HTTP) ───────────────────────────────────────────────

    @action.post(action_name="run")
    async def run_action(self):
        """Run this agent once. `POST /agent/<id>/run  {"prompt": "..."}`

        The UI's entry point. Deliberately a command that ACKNOWLEDGES rather
        than a bare bus emission: the caller needs the process id to navigate
        to the run, and a fire-and-forget emit with no registered handler would
        be a silent no-op. The lifecycle is emitted as node-addressed events
        alongside — see ``agent_run.dispatch_agent_run``, which owns the
        local/remote routing.
        """
        from flow_sdk.builtin.agent_run import dispatch_agent_run  # noqa: PLC0415
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        prompt = str((body or {}).get("prompt") or "").strip()
        if not prompt:
            return ApiFailResponse(message="prompt is required")
        if not self.enabled:
            return ApiFailResponse(message=f"agent {self.name!r} is disabled")

        deployment = await self.local_deployment()
        try:
            process = await dispatch_agent_run(deployment, prompt)
        except NotImplementedError as exc:
            return ApiFailResponse(message=str(exc))
        except Exception as exc:
            return ApiFailResponse(message=f"run failed: {exc}")

        return ApiSuccessResponse(
            data={
                "process_id": process.id,
                "process_typeid": str(process.typeid),
                "deployment_id": deployment.id,
                "compute_node_id": deployment.compute_node_id,
            }
        )

    # ── the use verb (HTTP) ───────────────────────────────────────────────

    @action.post(action_name="use")
    async def use_action(self):
        """Open a session as this agent. `POST /agent/<id>/use` → process id.

        No prompt: the process is created and shown, and the human types the
        first message. Local placement only — same routing rule as ``run``.

        The optional body ``project_id`` names the project the session ACTS IN,
        which is not always the project the agent lives in — see ``Agent.use``
        in the TS SDK for why. Omitted, it falls back to the agent's own project.
        """
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        project_id = str((body or {}).get("project_id") or "").strip() or None

        deployment = await self.local_deployment()
        try:
            process = await deployment.use(project_id=project_id)
        except NotImplementedError as exc:
            return ApiFailResponse(message=str(exc))
        except Exception as exc:  # noqa: BLE001 — incl. the disabled-agent refusal from build()
            return ApiFailResponse(message=f"use failed: {exc}")
        return ApiSuccessResponse(
            data={
                "process_id": process.id,
                "process_typeid": str(process.typeid),
                "deployment_id": deployment.id,
            }
        )

    # ── projection into the launch bundle ─────────────────────────────────

    @property
    def display_name(self) -> str:
        """How the agent is PRESENTED — the authored title, else the slug, else the id.
        Mirrors ``Agent.getDisplayName`` in ts_sdk so both tiers name it alike."""
        return (self.title or "").strip() or self.name or self.id

    def to_agent_options(self, worker_type: Optional[str] = None, **cli_extra) -> "AgentOptions":
        """Build the vendor options object this agent launches with.

        Only ever sets keys that already exist in ``to_json()`` — the serialized
        shape must stay byte-identical, because ``last_started_hash`` is an md5
        over it and any new/renamed key would flip ``restart_required`` on every
        running process. ``system_prompt`` deliberately does NOT appear here: it
        travels via ``context_data.instructions`` (see ``Deployment.build``).

        ``additional_dirs`` is deliberately absent too: both drivers overwrite
        ``cmd.add_dirs`` with ``AgenticProcess.resolved_add_dirs`` at spawn, so a
        copy here would be dead on arrival AND would perturb the very hash this
        docstring is protecting. The process field is the single source.

        ``cli_extra`` are per-launch transport keys (``output_format`` for a chat
        surface) that go through the CONSTRUCTOR: ``ClaudeAgentOptions`` derives
        ``verbose`` from ``output_format`` there, so setting the field after the
        fact would persist an inconsistent pair into ``cli_config``.
        """
        from flow_sdk.builtin.agentic_process.cli_drivers import factory  # noqa: PLC0415

        # Vendor extras first, so a named field always wins over a free-form key
        # of the same name.
        cli_json: dict = dict(self.cli_options or {})
        for key, value in (
            ("model", self.model),
            ("permission_mode", self.permission_mode),
            ("effort", self.effort),
        ):
            if value is not None:
                cli_json[key] = value
        cli_json.update({k: v for k, v in cli_extra.items() if v is not None})

        return factory(cli_json, driver_key(worker_type or self.worker_type))
