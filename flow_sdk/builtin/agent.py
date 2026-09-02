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
import logging
from typing import TYPE_CHECKING, ClassVar, Optional

from pydantic import PrivateAttr

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.builtin.deployment import KIND_AGENT, Deployment
from flow_sdk.builtin.email_inbox import EmailInbox
from flow_sdk.core import Entity, action
from flow_sdk.flowpad_types.vendors import Vendor, default_vendor, vendor_for
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.data_spec import Body, FrontMatter, SpecType
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgentOptions
    from flow_sdk.builtin.mcp import Mcp
    from flow_sdk.schema.data_spec.mcp_spec import McpSpec

logger = logging.getLogger(__name__)

#: The two vocabularies for "which CLI": an agent.md declares the DRIVER
#: short-id (``VENDORS[...].key``), ``AgenticProcess.worker_type`` carries the
#: persisted value (``.worker_type``). Both directions read the one table; a
#: blank ``worker_type:`` means "unset" and follows ``get_driver``'s default.

def _vendor(worker: str | None) -> Vendor:
    return vendor_for(worker) if (worker or "").strip() else default_vendor()


def driver_key(worker: str | None) -> str:
    """The ``cli_drivers.factory`` key for either vocabulary."""
    return _vendor(worker).key


def worker_type_value(worker: str | None) -> str:
    """The ``AgenticProcess.worker_type`` enum value for either vocabulary."""
    return _vendor(worker).worker_type


class AgentSpec(FrontMatter):
    """``agent.md`` — the shape of the document. ``name`` is deliberately NOT
    here: it comes from the folder (``TypeInfo.name_from_path``), so a rename
    can never desync the two. ``system_prompt`` is the markdown ``Body``.

    ``input`` / ``output`` are the agent's I/O contract — shapes authored
    in YAML. They are declaration only and never enter ``to_agent_options``:
    that bundle is md5'd into ``last_started_hash``, and a new key there would
    flip ``restart_required`` on every running process.
    """

    title: Optional[str] = None
    description: Optional[str] = None
    avatar: Optional[str] = None
    worker_type: Optional[str] = None
    model: Optional[str] = None
    permission_mode: Optional[str] = None
    effort: Optional[str] = None
    max_turns: Optional[int] = None
    tools: Optional[list[str]] = None
    disallowed_tools: Optional[list[str]] = None
    skills: Optional[list[str]] = None
    mcp_servers: Optional[list[str]] = None
    subagents: Optional[list[str]] = None
    additional_dirs: Optional[list[str]] = None
    load_flowpad_assistant: Optional[bool] = None
    cli_options: Optional[dict] = None
    enabled: Optional[bool] = None
    input: Optional[SpecType] = None
    output: Optional[SpecType] = None
    system_prompt: Body = ""


class Agent(Entity):
    """``agentic-assets/agent/<name>/`` — the ROW. Its shape on disk is
    ``AgentSpec`` (``TypeInfo.asset_spec``); that ``agent.md`` is the main file
    and the folder names the agent is ``TypeInfo``'s (the serializer's)."""

    type: str = APIField(default=EntityType.AGENT.value)
    _inbox: EmailInbox | None = PrivateAttr(default=None)

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
    # DECLARATION, not the attachment. An agent's servers are ASSETS in its own
    # folder (``agentic-assets/mcp/<name>/``), reached via ``mcp_assets()`` —
    # that structural 1:1 is still what a launch reads, and it is what makes a
    # RECEIVED agent carry its servers instead of dangling TypeIds. This list is
    # the AUTHORED intent that produces it: ids the editor writes into agent.md,
    # materialized into the folder by ``attach_declared_mcp_servers`` at process
    # creation. Two layers on purpose — the list can name an asset that lives
    # anywhere (the project's own ``agentic-assets/mcp/``), while the folder
    # holds the self-contained copy that travels.
    mcp_servers: list[TypeId] = APIField(
        default_factory=list,
        description="Mcp assets this agent declares, as TypeIds. Attached to the agent's own "
        "folder at process creation; mcp_assets() remains what a launch resolves.",
    )
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

    # ── I/O contract ──────────────────────────────────────────────────────
    # What this agent consumes and produces — `input + template → output`.
    # Authored as shapes in agent.md frontmatter (a class, held via SpecType). DECLARATION ONLY: they
    # never enter `to_agent_options`, whose to_json() is md5'd into
    # `last_started_hash` — a new key there flips `restart_required` on every
    # running process (the same reason `system_prompt` stays out).
    input: Optional[SpecType] = APIField(default=None, description="The shape this agent consumes.")
    output: Optional[SpecType] = APIField(default=None, description="The shape this agent produces.")

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
        here — through `normalize_email`, the funnel every other email
        comparison in the system uses. This is a gate that decides who may drive
        an agent with tools, so it must keep agreeing with `is_self_address`
        rather than carrying its own casefold.
        """
        from flow_sdk.builtin.user import normalize_email  # noqa: PLC0415

        if not self.email_enabled:
            return False
        candidate = normalize_email(address)
        if not candidate:
            return False
        return any(candidate == normalize_email(a) for a in self.email_allowed_senders)

    # ── lifecycle ─────────────────────────────────────────────────────────
    enabled: bool = APIField(default=True, description="Kill switch — a disabled agent refuses to launch.")
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)

    _api_visible: ClassVar[bool] = True

    # ── MCP servers ───────────────────────────────────────────────────────

    async def mcp_assets(self) -> list["Mcp"]:
        """The MCP assets owned by this agent — its folder IS the list.

        Nested repo assets are parented by the indexer (``repo_assets_fn``
        descends into a folder asset and stamps ``parent_type_id``), so this is
        a scoped lookup rather than a walk.
        """
        from flow_sdk.builtin.mcp import Mcp  # noqa: PLC0415

        return await Mcp.get_all({"match": {"parent_type_id": str(self.typeid)}})

    async def resolved_mcp_specs(self) -> list["McpSpec"]:
        """This agent's servers as launch payloads, deduped by name."""
        from flow_sdk.builtin.agentic_process.cli_drivers.mcp_projection import (  # noqa: PLC0415
            dedupe_by_name,
        )

        return dedupe_by_name(asset.to_spec() for asset in await self.mcp_assets())

    async def add_mcp(self, spec: "McpSpec") -> bool:
        """Attach an MCP server to this agent; return whether it changed.

        Writes an ASSET, not a list entry — that is what makes the server
        indexed, visible in the asset list with a scope, and carried along when
        the agent is shared. Saving the row is the whole mechanism: placement
        materializes ``agentic-assets/mcp/<name>/mcp.json`` NESTED under this
        agent's folder (because ``parent_type_id`` names it) and mints the v4
        into the folder's identity capsule. Hand-writing the file instead would
        need a root-scoped reindex to get parented — ``reindex_paths`` is
        resolution-only and would leave the asset orphaned.
        """
        from flow_sdk.builtin.agentic_process.cli_drivers import get_driver  # noqa: PLC0415
        from flow_sdk.builtin.mcp import Mcp  # noqa: PLC0415

        # Rendering is the validation: refuse a spec this agent's harness cannot
        # express (a dotted name under codex) at author time, not at spawn.
        get_driver(driver_key(self.worker_type)).prepare_process_mcp([spec])

        existing = {asset.name: asset for asset in await self.mcp_assets()}
        current = existing.get(spec.name)
        patch = spec.model_dump()
        # Compare the AUTHORED fields, not ``to_spec()``: that is the LAUNCH
        # payload, and for a bundled server it carries a resolved absolute path
        # in ``args`` that no incoming spec has — so the round-trip could never
        # be equal and every add re-saved.
        if current is not None and all(getattr(current, key, None) == value for key, value in patch.items()):
            return False

        # Mechanical: ``Mcp``'s field names ARE ``McpSpec``'s (enforced at
        # registration by ``SchemaRegistry.check_asset_spec``), so a field added
        # to the spec cannot silently stop being persisted here.
        row = current or Mcp(parent_type_id=str(self.typeid))
        for field, value in patch.items():
            setattr(row, field, value)
        await row.save(notify=False)
        return True

    async def remove_mcp(self, name: str) -> bool:
        """Detach one MCP server by name; return whether it changed."""
        for asset in await self.mcp_assets():
            if asset.name == name:
                await asset.delete()
                return True
        return False

    async def attach_declared_mcp_servers(self) -> int:
        """Materialize the declared ``mcp_servers`` ids as attached assets.

        The bridge between the two layers: ``mcp_servers`` is the AUTHORED
        intent (ids the editor writes into ``agent.md``, pointing at Mcp assets
        that typically live in the project, not under this agent), while
        ``mcp_assets()`` is the structural attachment a launch actually reads.
        This walks the first and produces the second. Returns how many
        attachments changed.

        Called from ``Deployment.create_process`` so the copy onto the process
        sees them. Idempotent — ``add_mcp`` answers False when the row already
        matches, so re-launching an unchanged agent writes nothing.

        A declared id that no longer resolves is SKIPPED with a warning rather
        than raised: a dangling reference must not make an agent unlaunchable,
        and the list is authored by a UI that can outlive the asset it named.

        ``entrypoint`` is deliberately CLEARED on the way through. ``to_spec()``
        has already resolved a bundled server's entrypoint into an absolute path
        in ``args``, so the attached copy is a plain command that runs the
        ORIGINAL asset's code. Carrying the entrypoint across instead would
        break it twice over: the nested row would append its own folder's path a
        second time, and ``save`` would scaffold a fresh hello-world
        ``server.py`` beside it — so the agent would launch a template, not the
        server the user wrote.
        """
        from flow_sdk.builtin.mcp import Mcp  # noqa: PLC0415

        changed = 0
        for declared in self.mcp_servers or []:
            # Coerced here, not trusted: the field validates on CONSTRUCTION
            # (a row read back from disk holds TypeIds), but ``Agent`` does not
            # set ``validate_assignment``, so an in-memory ``agent.mcp_servers =
            # [...]`` leaves plain strings behind. Both shapes reach this loop.
            try:
                ref = declared if isinstance(declared, TypeId) else TypeId(str(declared))
            except ValueError:
                logger.warning("agent %s declares an unparseable MCP id %r — skipped", self.name, declared)
                continue
            row = await Mcp.get_by_id(ref.id) if ref.id else None
            if row is None:
                logger.warning("agent %s declares MCP %s, which does not resolve — skipped", self.name, ref)
                continue
            spec = row.to_spec().model_copy(update={"entrypoint": ""})
            if await self.add_mcp(spec):
                changed += 1
        return changed

    # ── running this agent ────────────────────────────────────────────────
    # The Python surface. ``run_action`` / ``use_action`` are thin HTTP wrappers
    # over these; before, the only Python path from an agent to a process was
    # ``await (await agent.local_deployment()).create_process(...)``.
    #
    # ``deployment`` defaults to the LOCAL placement. It is a parameter rather
    # than always-resolved so a caller that already holds the deployment (the
    # HTTP actions, which put its id in their response) resolves it once.

    async def create_process(
        self, prompt: str = "", *, deployment: "Deployment | None" = None, **options
    ) -> "AgenticProcess":
        """This agent as a process. NOT saved, NOT started.

        The primitive — every field the agent declares (worker, model,
        permissions, system prompt, dirs, MCP servers) comes from the Agent;
        only per-run concerns are passed through.
        """
        target = deployment or await self.local_deployment()
        return await target.create_process(prompt, **options)

    async def launch(
        self, prompt: str, *, deployment: "Deployment | None" = None, wait: bool = False, **options
    ) -> "AgenticProcess":
        """``create_process`` + save + run the first turn.

        Goes through ``dispatch_agent_run`` rather than ``Deployment.launch``
        directly: that function owns the run lifecycle events and the refusal to
        silently run a remotely-placed agent here. Routing them through this verb
        means a Python caller gets both, not just the HTTP one.
        """
        from flow_sdk.builtin.agent_run import dispatch_agent_run  # noqa: PLC0415

        target = deployment or await self.local_deployment()
        return await dispatch_agent_run(target, prompt, wait=wait, **options)

    async def use(
        self, project_id: str | None = None, *, deployment: "Deployment | None" = None
    ) -> "AgenticProcess":
        """Open a session AS this agent — saved, visible, no first turn."""
        target = deployment or await self.local_deployment()
        return await target.use(project_id=project_id)

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
        if self.remote and self.origin:
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

    @property
    def inbox(self) -> EmailInbox | None:
        """The mailbox resolved for this Agent in the current SDK process."""
        return self._inbox

    async def enableEmail(self) -> EmailInbox:
        """Enable this Agent's Hub mailbox and its local ingest source.

        The Hub inbox is the formal identity; the ``cloud_email`` DataSource is
        the local polling projection. Both sides converge on ``agent_id``, so a
        retry adopts the existing mailbox and source rather than allocating or
        creating either one twice.
        """
        from flow_sdk.auth import LoginRequired  # noqa: PLC0415
        from flow_sdk.builtin.email_inbox_driver import (  # noqa: PLC0415
            EmailInboxError,
            get_email_inbox_driver,
        )
        from flow_sdk.cli.auth.hub_login import hub_auth_available  # noqa: PLC0415

        if not hub_auth_available():
            raise LoginRequired("FlowPad cloud login required to enable email")
        driver = get_email_inbox_driver()
        if not self.remote:
            try:
                await driver.get_inbox(self.id)
            except EmailInboxError as exc:
                if exc.status_code == 401:
                    raise LoginRequired("FlowPad cloud login required to enable email") from exc
                if exc.status_code != 404:
                    raise
                await self.share()
            else:
                # A previous attempt can publish the Agent and then fail while
                # allocating its mailbox. Adopt that Hub row on retry.
                self.remote = True
        try:
            descriptor = await driver.enable_inbox(self.id)
        except EmailInboxError as exc:
            if exc.status_code == 401:
                raise LoginRequired("FlowPad cloud login required to enable email") from exc
            raise
        inbox = self._adopt_inbox_descriptor(descriptor)

        await self._ensure_email_source(inbox)
        await self._set_email_enabled(True)
        return inbox

    async def disableEmail(self) -> EmailInbox | None:
        """Pause this Agent's Hub mailbox and local ingest source.

        This is deliberately reversible: the Hub allocation, address, local
        DataSource id and cursor all survive. A later :meth:`enableEmail`
        resumes the source from its last committed position.
        """
        from flow_sdk.auth import LoginRequired  # noqa: PLC0415
        from flow_sdk.builtin.data_source import DataSource, SourceStatus  # noqa: PLC0415
        from flow_sdk.builtin.email_inbox_driver import (  # noqa: PLC0415
            EmailInboxError,
            get_email_inbox_driver,
        )
        from flow_sdk.cli.auth.hub_login import hub_auth_available  # noqa: PLC0415
        from flow_sdk.ingest.drivers.cloud_email import CloudEmailDriver  # noqa: PLC0415

        if not hub_auth_available():
            raise LoginRequired("FlowPad cloud login required to disable email")
        try:
            descriptor = await get_email_inbox_driver().disable_inbox(self.id)
        except EmailInboxError as exc:
            if exc.status_code == 401:
                raise LoginRequired("FlowPad cloud login required to disable email") from exc
            if exc.status_code == 404:
                descriptor = None
            else:
                raise

        await self._set_email_enabled(False)
        source = await DataSource.find_for_account(
            CloudEmailDriver.provider,
            CloudEmailDriver.identity_config_key,
            self.id,
        )
        if source is not None and source.status != SourceStatus.DISABLED.value:
            source.status = SourceStatus.DISABLED.value
            await source.save()

        self._inbox = self._adopt_inbox_descriptor(descriptor) if descriptor else None
        return self._inbox

    def _adopt_inbox_descriptor(self, descriptor) -> EmailInbox:
        """Refresh the formal projection without replacing the same entity object."""
        current = EmailInbox.from_hub_descriptor(descriptor, agent_typeid=self.typeid)
        if self._inbox is None or self._inbox.id != current.id:
            self._inbox = current
            return current
        for field in (
            "address",
            "display_name",
            "provider",
            "provider_inbox_id",
            "status",
            "agent_typeid",
        ):
            setattr(self._inbox, field, getattr(current, field))
        return self._inbox

    async def _set_email_enabled(self, enabled: bool) -> None:
        """Persist the local execution gate after lifecycle reconciliation."""
        if self.email_enabled != enabled:
            self.email_enabled = enabled
            await self.save()

    async def _mark_email_enabled(self) -> None:
        """Compatibility seam for callers/tests predating reversible disable."""
        await self._set_email_enabled(True)

    async def _ensure_email_source(self, inbox: EmailInbox):
        """Find or create the one local source that polls ``inbox``.

        ``agent_id`` is the natural key because the Hub addresses a mailbox by
        Agent. The allocated address is attribution data: it names the account
        and lets the projection recognize the Agent's own sent copies.
        """
        import flow_sdk.ingest.drivers  # noqa: F401, PLC0415 — register drivers
        from flow_sdk.builtin.data_source import DataSource, SourceStatus  # noqa: PLC0415
        from flow_sdk.ingest.drivers.cloud_email import CloudEmailDriver  # noqa: PLC0415

        key = CloudEmailDriver.identity_config_key
        source = await DataSource.find_for_account(CloudEmailDriver.provider, key, self.id)
        config = {
            key: self.id,
            "address": inbox.address,
            "inbox_typeid": str(inbox.typeid),
            "provider_inbox_id": inbox.provider_inbox_id,
        }
        if source is None:
            source = DataSource(
                name=f"Inbox {inbox.address}",
                provider=CloudEmailDriver.provider,
                kind=CloudEmailDriver.kind,
                config=config,
                account_key=inbox.address,
                account_identities=[inbox.address],
            )
        else:
            source.config = {**(source.config or {}), **config}
            source.kind = CloudEmailDriver.kind
            source.account_key = inbox.address
            source.account_identities = [inbox.address]
            source.status = SourceStatus.ACTIVE.value
            source.next_poll_at = None
        await source.save()
        return source

    async def _email_source(self):
        """The one local polling projection for this Agent, if it exists."""
        import flow_sdk.ingest.drivers  # noqa: F401, PLC0415
        from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
        from flow_sdk.ingest.drivers.cloud_email import CloudEmailDriver  # noqa: PLC0415

        return await DataSource.find_for_account(
            CloudEmailDriver.provider,
            CloudEmailDriver.identity_config_key,
            self.id,
        )

    async def _resolve_inbox(self) -> EmailInbox | None:
        """Refresh the formal Hub Inbox projection for this SDK process."""
        from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver  # noqa: PLC0415

        if not self.remote:
            self._inbox = None
            return None
        descriptor = await get_email_inbox_driver().get_inbox(self.id)
        self._inbox = self._adopt_inbox_descriptor(descriptor) if descriptor else None
        return self._inbox

    async def email_state(self) -> dict:
        """Reconcile and return the narrow state rendered by Agent Inbox UI."""
        from flow_sdk.auth import LoginRequired  # noqa: PLC0415
        from flow_sdk.builtin.data_source import SourceStatus  # noqa: PLC0415
        from flow_sdk.cli.auth.hub_login import hub_auth_available  # noqa: PLC0415

        if not hub_auth_available():
            raise LoginRequired("FlowPad cloud login required to load agent email")

        inbox = await self._resolve_inbox()
        source = await self._email_source()
        if inbox is not None and inbox.is_active:
            source = await self._ensure_email_source(inbox)
            await self._set_email_enabled(True)
        else:
            await self._set_email_enabled(False)
            if source is not None and source.status != SourceStatus.DISABLED.value:
                source.status = SourceStatus.DISABLED.value
                await source.save()

        source_data = None
        if source is not None:
            source_data = {
                "id": source.id,
                "typeid": str(source.typeid),
                "status": source.status,
                "poll_interval_seconds": source.poll_interval_seconds,
                "last_synced_at": (
                    source.last_synced_at.isoformat()
                    if hasattr(source.last_synced_at, "isoformat")
                    else source.last_synced_at
                ),
                "health": getattr(source.health, "value", source.health),
            }
        inbox_data = None
        if inbox is not None:
            inbox_data = {
                "typeid": str(inbox.typeid),
                "address": inbox.address,
                "display_name": inbox.display_name,
                "provider": inbox.provider,
                "provider_inbox_id": inbox.provider_inbox_id,
                "status": inbox.status,
                "agent_typeid": str(inbox.agent_typeid),
            }
        return {
            "agent_id": self.id,
            "enabled": bool(
                inbox
                and inbox.is_active
                and source
                and source.status == SourceStatus.ACTIVE.value
                and self.email_enabled
            ),
            "inbox": inbox_data,
            "source": source_data,
            "allowed_senders": list(self.email_allowed_senders),
        }

    async def configure_email(
        self,
        *,
        allowed_senders: list[str] | None = None,
        poll_interval_seconds: int | None = None,
    ) -> dict:
        """Update private Agent policy and the paired source's standing cadence."""
        from flow_sdk.builtin.data_source import MIN_POLL_INTERVAL_SECONDS  # noqa: PLC0415
        from flow_sdk.builtin.user import normalize_email  # noqa: PLC0415

        if allowed_senders is not None:
            normalized: list[str] = []
            for raw in allowed_senders:
                address = normalize_email(str(raw))
                if address and address not in normalized:
                    normalized.append(address)
            if normalized != self.email_allowed_senders:
                self.email_allowed_senders = normalized
                await self.save()

        if poll_interval_seconds is not None:
            if poll_interval_seconds < MIN_POLL_INTERVAL_SECONDS:
                raise ValueError(
                    f"poll_interval_seconds must be at least {MIN_POLL_INTERVAL_SECONDS}"
                )
            source = await self._email_source()
            if source is None:
                raise ValueError("enable email before configuring its refresh interval")
            if source.poll_interval_seconds != poll_interval_seconds:
                source.poll_interval_seconds = poll_interval_seconds
                await source.save()
        return await self.email_state()

    @action.get(action_name="email_state")
    async def email_state_action(self):
        """Browser projection of the formal Inbox and its local DataSource."""
        from flow_sdk.auth import LoginRequired  # noqa: PLC0415
        from flow_sdk.builtin.email_inbox_driver import EmailInboxError  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        try:
            return ApiSuccessResponse(data=await self.email_state())
        except LoginRequired as exc:
            return ApiFailResponse(message=str(exc), status_code=401)
        except EmailInboxError as exc:
            return ApiFailResponse(
                message=exc.reason or "could not load agent inbox",
                status_code=exc.status_code or 503,
            )

    @action.post(action_name="enable_email")
    async def enable_email_action(self):
        """Enable the Hub Inbox and paired local source."""
        from flow_sdk.auth import LoginRequired  # noqa: PLC0415
        from flow_sdk.builtin.email_inbox_driver import EmailInboxError  # noqa: PLC0415
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required", status_code=401)
        body = await request_info.get_post_data() or {}
        if body:
            return ApiFailResponse(message="enable_email does not accept settings", status_code=400)
        try:
            await self.enableEmail()
            return ApiSuccessResponse(data=await self.email_state())
        except LoginRequired as exc:
            return ApiFailResponse(message=str(exc), status_code=401)
        except EmailInboxError as exc:
            return ApiFailResponse(message=exc.reason, status_code=exc.status_code or 503)
        except Exception as exc:  # noqa: BLE001 — UI gets a stable action failure
            return ApiFailResponse(message=f"could not enable email: {exc}")

    @action.post(action_name="disable_email")
    async def disable_email_action(self):
        """Pause Hub Inbox + local source without releasing the address."""
        from flow_sdk.auth import LoginRequired  # noqa: PLC0415
        from flow_sdk.builtin.email_inbox_driver import EmailInboxError  # noqa: PLC0415
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        if body:
            return ApiFailResponse(message="disable_email does not accept settings", status_code=400)
        try:
            await self.disableEmail()
            return ApiSuccessResponse(data=await self.email_state())
        except LoginRequired as exc:
            return ApiFailResponse(message=str(exc), status_code=401)
        except EmailInboxError as exc:
            return ApiFailResponse(message=exc.reason, status_code=exc.status_code or 503)
        except Exception as exc:  # noqa: BLE001
            return ApiFailResponse(message=f"could not disable email: {exc}")

    @action.post(action_name="configure_email")
    async def configure_email_action(self):
        """Update private senders and the paired DataSource cadence."""
        from flow_sdk.auth import LoginRequired  # noqa: PLC0415
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        body = body or {}
        unknown = sorted(set(body) - {"allowed_senders", "poll_interval_seconds"})
        if unknown:
            return ApiFailResponse(
                message=f"unknown email setting(s): {', '.join(unknown)}",
                status_code=400,
            )
        allowed = body.get("allowed_senders")
        if allowed is not None and (
            not isinstance(allowed, list) or not all(isinstance(v, str) for v in allowed)
        ):
            return ApiFailResponse(message="allowed_senders must be a list of addresses")
        interval = body.get("poll_interval_seconds")
        if interval is not None:
            if isinstance(interval, bool):
                return ApiFailResponse(message="poll_interval_seconds must be an integer")
            try:
                interval = int(interval)
            except (TypeError, ValueError):
                return ApiFailResponse(message="poll_interval_seconds must be an integer")
        try:
            return ApiSuccessResponse(
                data=await self.configure_email(
                    allowed_senders=allowed,
                    poll_interval_seconds=interval,
                )
            )
        except LoginRequired as exc:
            return ApiFailResponse(message=str(exc), status_code=401)
        except ValueError as exc:
            return ApiFailResponse(message=str(exc))
        except Exception as exc:  # noqa: BLE001
            return ApiFailResponse(message=f"could not configure email: {exc}")

    @action.get(action_name="inbox_scope")
    async def inbox_scope_action(self):
        """IDs admitted to this Agent's local Inbox and Conversation views."""
        from flow_sdk.inbox.agent_scope import (  # noqa: PLC0415
            AgentInboxScopeError,
            resolve_agent_inbox_scope,
        )
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        try:
            scope = await resolve_agent_inbox_scope(self.id)
            return ApiSuccessResponse(data=scope.as_dict())
        except AgentInboxScopeError as exc:
            return ApiFailResponse(message=str(exc), status_code=exc.status_code)

    async def provision_inbox(self, actor: TypeId | None = None, **options) -> dict:
        """Give this agent an email address of its own.

        The mailbox needs an Agent row on the Hub, but not a Git deployment.
        A local-only Agent is registered through the ordinary share path first;
        this intentionally does not require a Project, GitHub, or Git publish.

        **Adopt before allocating.** An agent that already has an active mailbox
        gets that one back — never a second address. This is not just tidiness:
        an address is billable and permanent, and callers retry (the UI creates
        the DataSource in a second step, which can fail). Idempotence is what
        makes that retry safe, and it is enforced on both sides — here, and again
        at the backend.
        """
        from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver  # noqa: PLC0415

        driver = get_email_inbox_driver()
        if not self.remote:
            await self.share()

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

        deleted = await get_email_inbox_driver().delete_inbox(self.id)
        self._inbox = None
        return deleted

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
        from flow_sdk.assets.git_publish import AssetPublishError  # noqa: PLC0415

        try:
            data = await self.deploy_to_cloud(actor)
        except AssetPublishError as exc:
            # Deploy publishes the agent through git first, so every publish
            # precondition is a deploy precondition. These are the caller's
            # state, not a server fault — reporting them as 500 both mislabels
            # them in logs and loses the sentence that says what to do.
            return ApiFailResponse(
                status_code=exc.status_code,
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
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        prompt = str((body or {}).get("prompt") or "").strip()
        if not prompt:
            return ApiFailResponse(message="prompt is required")
        if not self.enabled:
            return ApiFailResponse(message=f"agent {self.name!r} is disabled")

        # Resolved here and passed in: the response payload names it, so letting
        # ``launch`` resolve its own would be a second get-or-create round trip.
        deployment = await self.local_deployment()
        try:
            process = await self.launch(prompt, deployment=deployment)
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
            process = await self.use(project_id=project_id, deployment=deployment)
        except NotImplementedError as exc:
            return ApiFailResponse(message=str(exc))
        except Exception as exc:  # noqa: BLE001 — incl. the disabled-agent refusal from create_process()
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
