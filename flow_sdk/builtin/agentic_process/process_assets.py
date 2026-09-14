"""Process attachment and launch policy over shared asset operations."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import Field

from flow_sdk.assets.directory import AssetDir
from flow_sdk.assets.materialize import MaterializationMode
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import ProcessHookRuntime, ProcessMcpRuntime
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

logger = logging.getLogger(__name__)

class SystemInstructionAssets(DataSpec):
    """This process's asset MOUNT, plus the instruction text when there is any.

    The mount is the load-bearing half: it is how a worker discovers embedded
    skills and sub-agents. Instruction TEXT is a separate, optional concern — a
    process can have skills and nothing to say — so ``instructions`` may be ``""``
    and ``claude_file`` ``None``. Gating the whole object on the text is what
    silently starved opencode's generated config and copilot's custom-instruction
    dirs of the assets dir whenever a process had skills but no persona.
    """

    assets_dir: Path
    instructions: str = ""
    claude_file: Path | None = None

    @property
    def system_prompt_file(self) -> str | None:
        """The system-prompt file path, or None when there is no text.

        The one place the "no text ⇒ no file to point at" coercion is stated.
        """
        return str(self.claude_file) if self.claude_file else None

    # The owning process. Every vendor but opencode reaches these assets through
    # a directory flag and needs nothing else; opencode reaches them ONLY through
    # a generated per-process config, which is keyed on this id.
    process_id: str = ""


class PreparedProcessAssets(DataSpec):
    """Derived launch assets prepared once for one worker spawn."""

    instruction_assets: SystemInstructionAssets | None = None
    hook_runtime: ProcessHookRuntime = Field(default_factory=ProcessHookRuntime)
    mcp_runtime: ProcessMcpRuntime = Field(default_factory=ProcessMcpRuntime)



class ProcessAssets:
    def __init__(self, process: AgenticProcess):
        self.process = process

    async def load_embedded_subagent_action(
        self, asset_ref: str = "", set_ap_persona: bool = False,
    ) -> ApiSuccessResponse | ApiFailResponse:
        from flow_sdk.assets.asset import Asset

        if not asset_ref:
            return ApiFailResponse(message="asset_ref is required")
        try:
            from flow_sdk.assets.process_projection import import_subagent
            source = Asset.from_path(asset_ref)
            if source.typeid.type == EntityType.SUBAGENT:
                ref = source.typeid
                projection = await self._materialize_source(ref, source=source)
            else:
                prior = next((TypeId(key).id for key, value in self._receipts().items()
                              if value.get("source") == str(Path(asset_ref).expanduser().resolve())), None)
                ref, projection = import_subagent(Path(asset_ref), self.ensure_process_assets().os_path,
                                                  existing_id=prior)
                projection = await self._place_projection(ref, projection)
            if set_ap_persona:
                self.process.process_persona_path = projection.path.relative_to(self._process_assets_path()).as_posix()
            self._drop_legacy_agent_name(projection.name)
            self._normalize_process_asset_mount()
            self._record_embedded_ref(ref)
            await self.process.save()
            return ApiSuccessResponse(data={"ok": True, "name": projection.name, "ref": str(ref)})
        except (OSError, ValueError, LookupError) as exc:
            return ApiFailResponse(message=str(exc))

    def _drop_legacy_agent_name(self, name: str | None) -> None:
        """Migrate-on-touch: strip a legacy ``embedded_subagent_ids`` name entry."""
        if name and name in (self.process.embedded_subagent_ids or []):
            self.process.embedded_subagent_ids = [n for n in self.process.embedded_subagent_ids if n != name]


    async def load_embedded_skill_action(self, asset_ref: str = "") -> ApiSuccessResponse | ApiFailResponse:
        from flow_sdk.assets.asset import Asset

        if not asset_ref:
            return ApiFailResponse(message="asset_ref is required")
        try:
            source = Asset.from_path(asset_ref)
            if source.typeid.type != EntityType.SKILL:
                raise ValueError(f"Not a skill asset: {asset_ref}")
            ref = source.typeid
            projection = await self._materialize_source(ref, source=source, mode=MaterializationMode.LINK)
            self._normalize_process_asset_mount()
            self._record_embedded_ref(ref)
            await self.process.save()
            return ApiSuccessResponse(data={"ok": True, "name": projection.name,
                                            "link": str(projection.path), "ref": str(ref)})
        except (OSError, ValueError, LookupError) as exc:
            return ApiFailResponse(message=str(exc))

    def _embedded_skill_path(self, ref: TypeId, assets_dir: Path) -> Path | None:
        receipt = self._receipts().get(str(ref))
        if receipt is not None:
            return Path(receipt["path"])
        from flow_sdk.assets.folder import AssetFolder
        return next((asset.path for asset in AssetFolder(path=self._skills_root(assets_dir)).assets()
                     if asset.typeid == ref), None)

    def _record_embedded_ref(self, ref: "TypeId | None") -> None:
        """Record ``ref`` in ``embedded_asset_refs``, idempotently.

        The bookkeeping half of embedding, shared by all three placement paths
        (sub-agent, skill symlink, entity copy). It is what makes the process
        say "I have assets" on the NEXT request's fresh entity — the predicate
        both ``resolved_add_dirs`` and ``_prepare_system_instruction_assets``
        read to decide whether to mount the assets dir. A placement path that
        skips it lays real files down that no worker can see.

        Callers still ``save()`` themselves: they have other fields to flush in
        the same write.
        """
        if ref is None:
            return
        refs = list(self.process.embedded_asset_refs or [])
        if not any(r.type == ref.type and r.id == ref.id for r in refs):
            self.process.embedded_asset_refs = refs + [ref]


    @staticmethod
    def _skill_source_folder(skill: "Any") -> str | None:
        """Resolve a skill's source folder from a path, FSRef, or entity/record."""
        if isinstance(skill, str):
            return skill or None
        asset_ref = getattr(skill, "asset_ref", None)
        if isinstance(asset_ref, str):
            return asset_ref or None
        inner = getattr(asset_ref, "_path", None) or getattr(asset_ref, "path", None)
        return str(inner) if inner else (str(skill.record_dir) if getattr(skill, "record_dir", None) else None)


    async def load_skill(self, skill: "Any") -> "ApiSuccessResponse | ApiFailResponse":
        """Load a skill so this process's worker discovers it — worker-aware.

        ``skill`` may be a ``Skill`` entity (``Skill.from_fs_ref(folder)``), an
        FSRecord, or the skill folder path. Resolves it to its source folder and
        materializes it into the right location for the process's worker (see
        ``_skills_root``). The Python counterpart of TS ``loadEmbeddedSkill``.
        """
        source = self._skill_source_folder(skill)
        if not source:
            return ApiFailResponse(message="Could not resolve skill source folder")
        return await self.load_embedded_skill_action(asset_ref=source)


    def load_embedded_subagent(self, agent: "Any") -> None:
        """Embed a sub-agent into this process so it is registered via --agents at launch.

        Accepts a SubAgent record, any object with to_agents_json(), or a name string.
        Adds the sub-agent's name to the persisted embedded_subagent_ids list and
        stores the record in the in-memory _embedded_agents list.
        """
        from flow_sdk.builtin.subagent_loading import load_subagent as _load_subagent  # noqa: PLC0415
        from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

        _agents: list = object.__getattribute__(self.process, "__dict__").setdefault("_embedded_agents", [])
        if isinstance(agent, str):
            rec = _load_subagent(agent) or FSRecord(type=RecordType.SUBAGENT, name=agent, id=agent)
        else:
            # duck-type: Record or anything with name/id
            rec = agent
        _agents.append(rec)
        name = rec.name if hasattr(rec, "name") else str(agent)
        if name and name not in (self.process.embedded_subagent_ids or []):
            self.process.embedded_subagent_ids = list(self.process.embedded_subagent_ids or []) + [name]


    def get_agents_json(self) -> "dict | None":
        """Return merged --agents JSON from all embedded sub-agents, or None if none loaded.

        Falls back to the persisted ``cli_config.agents_json`` for legacy
        processes created before embedded sub-agents were materialized as assets.
        """
        _agents: list = object.__getattribute__(self.process, "__dict__").get("_embedded_agents", [])
        if _agents:
            from flow_sdk.assets.types.subagent import subagent_to_cli_json  # noqa: PLC0415

            result: dict = {}
            for rec in _agents:
                if hasattr(rec, "to_agents_cli_json"):
                    result.update(rec.to_agents_cli_json())
                else:
                    result.update(subagent_to_cli_json(rec))
            if result:
                return result
        persisted = (self.process.cli_config or {}).get("agents_json") or None
        return persisted or None


    @staticmethod
    def _render_persona_section(name: str | None, entry: dict | None) -> list[str]:
        """The persona's own block -- the identity directive and its spec.

        Empty when the process has no persona, which is what keeps the identity
        from being handed to whichever agent happens to be there.
        """
        if not name:
            return []
        entry = entry or {}
        desc = entry.get("description") or ""
        body = entry.get("prompt") or ""
        out = [
            f"# You are the '{name}' agent",
            (
                "The user is chatting with you (this agent) directly. "
                "Adopt the persona and follow the instructions below for "
                "every reply, even when the user does not name the agent. "
                "Execute side-effect instructions literally (file writes, "
                "command outputs); do not paraphrase or summarise away "
                "required artifacts."
            ),
        ]
        if desc:
            out.append(f"\n## Description\n{desc}")
        if body:
            out.append(f"\n## Instructions\n{body}")
        return out


    @staticmethod
    def _render_subagent_sections(agents: "list[tuple[str, dict]]", persona: str | None) -> list[str]:
        """The non-persona agents, one ## block each. Empty when there are none.

        The heading turns on whether a persona holds the identity: beneath one
        they are subordinate sub-agents, without one they are a flat catalogue.
        """
        if not agents:
            return []
        if persona:
            out = [
                "\n# Sub-agents available to you",
                (
                    "The ## blocks below are ADDITIONAL specialised agents you may draw "
                    f"on. They do NOT replace your persona -- you remain the '{persona}' "
                    "agent for every reply. When a request falls squarely in one of "
                    "their areas, execute that agent's instructions yourself in this "
                    "same turn rather than delegating to a separate sub-agent; "
                    "otherwise ignore them. Never introduce yourself as one of these "
                    "agents, and never decline a request on the grounds that it falls "
                    "outside one of their scopes."
                ),
            ]
        else:
            out = [
                "# Embedded agent specs",
                (
                    "Each ## block below is the canonical instruction body for a "
                    "named agent. When the user instruction names one of these "
                    "agents, do not delegate to a separate sub-agent. Execute the "
                    "agent instructions yourself in this same turn and follow "
                    "side-effect instructions literally."
                ),
            ]
        for name, entry in agents:
            entry = entry or {}
            desc = entry.get("description") or ""
            body = entry.get("prompt") or ""
            out.append(f"\n## {name}")
            if desc:
                out.append(desc)
            if body:
                out.append(body)
        return out


    @staticmethod
    def _render_agents_instruction_block(agents_json: dict | None, persona_path: str | None = None) -> str:
        """Render the embedded sub-agents into the system-instruction text.

        ``persona_path`` (the process's ``process_persona_path``) names the agent
        that IS this process's identity: it carries the "you are this agent"
        directive and the others render beneath it. When it is None or names an
        agent that is not embedded, nothing is promoted -- the block stays a flat
        catalogue and the worker keeps its own identity. Declared, never inferred.
        """
        agents_json = agents_json or {}
        if not agents_json:
            return ""

        # The stem IS the frontmatter name: `load_embedded_subagent_action`
        # writes `<name>.md` from the same `name` that keys `agents_json`.
        persona = Path(persona_path).stem if persona_path else None
        if persona not in agents_json:
            if persona is not None:
                # Declared but not embedded: the materialized file is gone or no
                # longer parses. Should never happen; the session silently loses
                # its identity when it does, so say so rather than infer one.
                logger.warning(
                    "persona %r declared (%s) but not among the embedded agents %s; rendering without a persona",
                    persona, persona_path, sorted(agents_json),
                )
            persona = None

        rest = [(n, e) for n, e in agents_json.items() if n != persona]
        sections = ProcessAssets._render_persona_section(persona, agents_json.get(persona))
        sections += ProcessAssets._render_subagent_sections(rest, persona)
        return "\n".join(sections)


    def _load_materialized_agents_json(self, assets_dir: Path) -> dict:
        from flow_sdk.assets.process_projection import materialized_agents_json
        return materialized_agents_json(assets_dir)


    async def _prepare_system_instruction_assets(self) -> SystemInstructionAssets | None:
        """Materialize process instructions into the process asset directory."""
        explicit = await self.process.resolve_system_instructions()
        legacy_agents = self.get_agents_json() or {}
        # Embedded assets must be detected from PERSISTED state, not just the
        # in-memory AssetDir handle: load-embedded-subagent runs on one entity
        # instance and save() invalidates the cache, so the prompt/launch
        # request gets a fresh instance whose _embedded_assets is None. Without
        # this, a materialized persona (e.g. vibe) silently never reaches the
        # worker's system instructions.
        has_existing_assets = self.embedded_assets is not None or bool(self.process.embedded_asset_refs)
        if not explicit and not legacy_agents and not has_existing_assets:
            return None

        asset_dir = self.ensure_process_assets()
        agents = {**legacy_agents, **self._load_materialized_agents_json(asset_dir.os_path)}
        agent_block = self._render_agents_instruction_block(agents, self.process.process_persona_path)
        instructions = "\n\n".join(p for p in (explicit, agent_block) if p).strip()

        self._normalize_process_asset_mount()

        claude_file = self.process.driver.prepare_instruction_assets(asset_dir, instructions)
        return SystemInstructionAssets(
            assets_dir=asset_dir.os_path,
            instructions=instructions,
            claude_file=claude_file,
            process_id=self.process.id,
        )


    async def prepare_process_assets(self) -> PreparedProcessAssets:
        """Prepare every derived asset contribution once for a launch.

        Hook projection is a driver concern. Drivers predating this contract
        are harmless while no process hook is configured.
        """
        instructions = await self._prepare_system_instruction_assets()
        hook_runtime = ProcessHookRuntime()
        supports_hooks = bool(getattr(self.process.driver, "supports_process_hooks", False))
        if self.process.process_hook_events or supports_hooks:
            prepare = getattr(self.process.driver, "prepare_process_hooks", None)
            if prepare is None:
                raise ValueError("process hooks are unsupported by this worker")
            # The driver decides whether its projection needs files. Passing a
            # lazy handle keeps inline-only integrations (Codex) write-free.
            assets = AssetDir(self._process_assets_path())
            hook_runtime = prepare(
                assets,
                str(self.process.id),
                tuple(self.process.process_hook_events),
            )
        mcp_runtime = ProcessMcpRuntime()
        prepare_mcp = getattr(self.process.driver, "prepare_process_mcp", None)
        if prepare_mcp is not None:
            mcp_runtime = prepare_mcp(self.process.resolved_mcp_servers())
        return PreparedProcessAssets(
            instruction_assets=instructions,
            hook_runtime=hook_runtime,
            mcp_runtime=mcp_runtime,
        )


    async def attach_embedded_asset(self, entity_ref: str = "") -> "ApiSuccessResponse | ApiFailResponse":
        """Materialize ``entity_ref`` under the process's assets dir + add to --add-dir.

        Wire param is the serialized TypeId string (``agent-<id>`` / ``skill-<id>``);
        it's parsed into a ``TypeId`` at this boundary.
        """
        if not entity_ref:
            return ApiFailResponse(message="entity_ref is required")
        try:
            ref = TypeId(entity_ref)
            projection = await self._materialize_source(ref)
            self._normalize_process_asset_mount()
            self._record_embedded_ref(ref)
            await self.process.save()
            return ApiSuccessResponse(data={"ok": True, "name": projection.name, "ref": entity_ref})
        except Exception as exc:
            logger.exception("attach_embedded_asset failed for %s", entity_ref)
            return ApiFailResponse(message=str(exc))


    async def detach_embedded_asset(self, entity_ref: str = "") -> "ApiSuccessResponse | ApiFailResponse":
        """Remove materialized files + drop the ref from embedded_asset_refs."""
        if not entity_ref:
            return ApiFailResponse(message="entity_ref is required")
        try:
            ref = TypeId(entity_ref)
            assets_dir = await self._assets_dir_path()
            await self._unmaterialize_entity(ref, assets_dir)
            refs = [r for r in (self.process.embedded_asset_refs or []) if not (r.type == ref.type and r.id == ref.id)]
            self.process.embedded_asset_refs = refs
            if ref.type == EntityType.SUBAGENT and self.process.embedded_subagent_ids:
                # Legacy processes may still carry the agent by NAME — drop it
                # too, or the persona file is gone while an INLINE row lingers.
                from flow_sdk.builtin.subagent_loading import get_subagent  # noqa: PLC0415

                agent = get_subagent(ref.id)
                self._drop_legacy_agent_name(agent.name if agent else None)
            await self.process.save()
            return ApiSuccessResponse(data={"ok": True, "ref": entity_ref})
        except Exception as exc:
            logger.exception("detach_embedded_asset failed for %s", entity_ref)
            return ApiFailResponse(message=str(exc))


    def _receipts(self) -> dict:
        return dict((self.process.context_data or {}).get("asset_projections") or {})

    def _store_receipt(self, ref: TypeId, receipt: dict | None) -> None:
        receipts = self._receipts()
        if receipt is None:
            receipts.pop(str(ref), None)
        else:
            receipts[str(ref)] = receipt
        self.process.context_data = {**(self.process.context_data or {}), "asset_projections": receipts}

    async def _materialize_source(self, ref: TypeId, *, source=None,
                                  mode: MaterializationMode = MaterializationMode.COPY):
        from flow_sdk.assets.process_projection import resolve_embedding

        root = self.ensure_process_assets().os_path
        skills_root = self._skills_root(root)
        if ref.type == EntityType.SKILL and not skills_root.resolve().is_relative_to(root.resolve()):
            raise ValueError("This worker does not support process-local skill attachment")
        projection = await resolve_embedding(ref, root, skills_root, source)
        if projection is None:
            raise ValueError(f"Unsupported entity type for embed: {ref}")
        return await self._place_projection(ref, projection, mode=mode)

    async def _place_projection(self, ref, projection, *, mode=MaterializationMode.COPY):
        import asyncio

        from flow_sdk.assets.process_projection import ProjectionReceipt, materialize_projection
        receipts = {key: ProjectionReceipt.model_validate(value) for key, value in self._receipts().items()}
        receipt = await asyncio.to_thread(materialize_projection, projection, ref=ref, receipts=receipts, mode=mode)
        self._store_receipt(ref, receipt.model_dump(mode="json"))
        return projection.model_copy(update={"path": receipt.path})

    async def get_embedded_assets(self):
        from flow_sdk.assets.process_projection import embedded_assets
        root = self._process_assets_path()
        paths = [(ref, await self._materialized_path_for(ref, root)) for ref in self.process.embedded_asset_refs or []]
        return embedded_assets(paths)

    def embedded_mcp_specs(self):
        from flow_sdk.assets.types.mcp import read_mcp_assets
        paths = [Path(value["path"]) for key, value in self._receipts().items()
                 if TypeId(key).type == EntityType.MCP]
        return read_mcp_assets(paths)

    async def _materialized_path_for(self, ref: TypeId, assets_dir: Path) -> Path | None:
        receipt = self._receipts().get(str(ref))
        if receipt is not None:
            return Path(receipt["path"])
        return self._embedded_skill_path(ref, assets_dir) if ref.type == EntityType.SKILL else None

    async def _unmaterialize_entity(self, ref: TypeId, assets_dir: Path) -> None:
        receipt = self._receipts().get(str(ref))
        if receipt is None:
            return  # A legacy reference alone does not establish filesystem ownership.
        from flow_sdk.assets.process_projection import ProjectionReceipt, remove_projection
        remove_projection(ProjectionReceipt.model_validate(receipt))
        self._store_receipt(ref, None)

    @property
    def embedded_assets(self) -> AssetDir | None:
        return object.__getattribute__(self.process, "__dict__").get("_embedded_assets")

    def ensure_process_assets(self) -> AssetDir:
        asset_dir = self.embedded_assets
        if asset_dir is None:
            asset_dir = AssetDir(self._process_assets_path())
            object.__getattribute__(self.process, "__dict__")["_embedded_assets"] = asset_dir
        asset_dir.ensure()
        return asset_dir

    def _process_assets_path(self) -> Path:
        return self.process._record_dir() / "execution" / "assets"

    def _is_process_assets_path(self, path: str | Path) -> bool:
        try:
            return Path(path).expanduser().resolve() == self._process_assets_path().resolve()
        except (OSError, RuntimeError, TypeError, ValueError):
            return False

    async def _assets_dir_path(self) -> Path:
        return self.ensure_process_assets().os_path

    def _normalize_process_asset_mount(self) -> None:
        self.process.additional_dirs = [
            path for path in (self.process.additional_dirs or [])
            if not self._is_process_assets_path(path)
        ]

    def _skills_root(self, assets_dir: Path) -> Path:
        return self.process.driver.skills_root(self.process, assets_dir)
