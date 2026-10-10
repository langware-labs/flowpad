"""DiagnosisRequest — a FlowpadDiagnosis that someone ELSE runs and writes into.

Its owner opens it here (``open``): a local row, pushed to the hub at the same id with the generic
``Entity.share``, optionally funded with a public, capped, expiring LLM budget (the hub's ``fund``).
They send ``flow diagnose <id>`` to the person they support; that person's machine -- signed in or
not -- reads the hub's ``brief`` and ``submit``\\ s each run there, by id (``hub_anonymous_request``).
Only the owner reads the runs back (``runs``), and whoever they share the request with.

The diagnosis fields it inherits show the LATEST run; every run is kept whole on the hub.
The hub half is ``flowpad/hub/builtin/flowpad_diagnosis.py``.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.builtin.flowpad_diagnosis import FlowpadDiagnosis
from flow_sdk.schema.data_spec.diagnosis_request_spec import (
    DiagnosisAttachmentSpec,
    DiagnosisFundingSpec,
    DiagnosisRequestEditSpec,
    DiagnosisRequestOpenSpec,
)
from flow_sdk.schema.types import EntityType
from flow_sdk.stream_inbox._locks import keyed_loop_lock, new_registry

#: The assets an owner may send along: prompt-shaped ones only. An allowlist, not a blocklist --
#: a new file-backed type (a credential, a data source config) must not become sendable by default.
ATTACHABLE_ASSET_TYPES = frozenset(
    {EntityType.SKILL.value, EntityType.SUBAGENT.value, EntityType.MARKDOWN.value, EntityType.PROMPT.value}
)
#: Hub LLM providers a stored key can be uploaded as (``LLMProvider`` on the hub).
HUB_KEY_PROVIDERS = ("openrouter", "anthropic", "openai")
#: One lock per request, so two frames for the same run post one feed entry. Weak-valued
#: (``stream_inbox/_locks``): it lives only while an update holds or awaits it.
_update_locks = new_registry()
#: What the hub keeps fresh on the row -- read back by ``pull``, never sent.
_HUB_FIELDS = (
    "title",
    "symptoms",
    "rca",
    "fix",
    "summary",
    "user_report",
    "reported_by",
    "occurred_at",
    "os",
    "app_version",
    "write_expires_at",
    "max_run_bytes",
    "llm_endpoint_typeid",
    "run_count",
    "last_run_at",
)


class DiagnosisRequest(FlowpadDiagnosis):
    type: str = APIField(default=EntityType.DIAGNOSIS_REQUEST.value)
    instructions: Optional[str] = APIField(None, description="What the runner's agent is asked to do.")
    ask_permission: Optional[bool] = APIField(
        False, description="Whether `flow diagnose <id>` asks the runner before it runs, and before it sends."
    )
    write_expires_at: Optional[str] = APIField(
        None, description="ISO end of the window in which the id accepts runs. Sent at open; the hub clamps it."
    )
    max_run_bytes: Optional[int] = APIField(None, description="Largest run the hub accepts. Sent at open; clamped.")
    llm_endpoint_typeid: Optional[str] = APIField(
        None, sharing=Sharing.HUB_READ, description="The public hub budget a runner spends, set by the hub's fund."
    )
    run_count: Optional[int] = APIField(None, sharing=Sharing.HUB_READ, description="Runs the hub has kept.")
    last_run_at: Optional[str] = APIField(None, sharing=Sharing.HUB_READ, description="ISO time of the latest run.")

    #: Deleting the request deletes it on the hub too -- and the hub deletes the budget it opened.
    owns_hub_delete: ClassVar[bool] = True

    @property
    def command(self) -> str:
        """What the owner sends: everything else the runner needs is on the hub."""
        return f"flow diagnose {self.id}"

    @classmethod
    async def open(cls, spec: DiagnosisRequestOpenSpec, owner_typeid: str | None = None) -> "DiagnosisRequest":
        """Open a request: write it here, push it to the hub, fund it when asked. Raises ``HubError``."""
        from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415

        title = _title_of(spec.instructions)
        request = cls(
            id=mint_uuid(),
            name=title,
            title=title,
            instructions=spec.instructions,
            ask_permission=spec.ask_permission,
            project_id=spec.project_id or None,
            write_expires_at=(datetime.now(UTC) + timedelta(hours=spec.write_hours)).isoformat(),
            max_run_bytes=spec.max_run_mb * 1024 * 1024,
        )
        await request.save(owner_typeid)
        await request.share()
        await request.save(owner_typeid)  # persists ``remote=True`` -- ``share`` sets it in memory only
        if spec.funding is not None:
            await request.fund(spec.funding)
        for attachment in spec.attachments:
            await request.attach(attachment)
        return await request.pull()

    async def edit(self, spec: DiagnosisRequestEditSpec) -> "DiagnosisRequest":
        """Change what the owner set at open: the instructions and whether the runner is asked (both on
        the hub and here), the window and
        the run size (the hub's ``limits``, which clamps them like open), and the budget (a fresh
        ``fund`` -- the hub drops the one it replaces). Raises ``HubError``."""
        from flow_sdk.cloud_client.transport.hub_http import hub_post, hub_put  # noqa: PLC0415

        if spec.instructions is not None:
            name = _title_of(spec.instructions)
            body: dict[str, Any] = {"instructions": spec.instructions, "name": name}
            if not self.run_count:  # once a run came back, the title is the latest run's
                body["title"] = name
            await hub_put(EntityType.DIAGNOSIS_REQUEST.value, self.id, body)
            self.instructions, self.name = spec.instructions, name
            await self.save()
        if spec.ask_permission is not None:
            await hub_put(EntityType.DIAGNOSIS_REQUEST.value, self.id, {"ask_permission": spec.ask_permission})
            self.ask_permission = spec.ask_permission
            await self.save()
        limits: dict[str, Any] = {}
        if spec.write_hours is not None:
            limits["write_expires_at"] = (datetime.now(UTC) + timedelta(hours=spec.write_hours)).isoformat()
        if spec.max_run_mb is not None:
            limits["max_run_bytes"] = spec.max_run_mb * 1024 * 1024
        if limits:
            await hub_post(EntityType.DIAGNOSIS_REQUEST.value, limits, self.id, "limits")
        if spec.funding is not None:
            await self.fund(spec.funding)
        return await self.pull()

    async def fund(self, funding: DiagnosisFundingSpec) -> None:
        """Give the runner a budget: the hub allocates it from ``funding``'s source, public and capped.

        A key stored on THIS computer is first uploaded to the hub as an endpoint of its own --
        which is what the screen warns about -- since a stranger's machine can only spend what the
        hub holds.
        """
        from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

        source = funding.source_typeid or await _hub_root_for_local_key(funding.local_key_provider)
        body: dict[str, Any] = {
            "source": source,
            "cost_usd_total": funding.cost_usd_total,
            "expires_at": (datetime.now(UTC) + timedelta(hours=funding.hours)).isoformat(),
        }
        if funding.model:
            body["model"] = funding.model
        await hub_post(EntityType.DIAGNOSIS_REQUEST.value, body, self.id, "fund")

    async def attach(self, attachment: DiagnosisAttachmentSpec) -> dict[str, str]:
        """Send the runner a file or an asset: uploaded to the request's hub storage, where
        ``flow diagnose <id>`` fetches it from the brief. Returns ``{kind, name}``."""
        from flow_sdk.cloud_client.transport.hub_http import hub_upload_entity_file  # noqa: PLC0415

        if attachment.asset_typeid:
            kind, name, content = await _pack_asset(attachment.asset_typeid)
        else:
            import base64  # noqa: PLC0415

            kind, name, content = "files", attachment.file_name, base64.b64decode(attachment.content_b64)
        await hub_upload_entity_file(
            EntityType.DIAGNOSIS_REQUEST.value, self.id, name, content, sub_path=f"upload/attachments/{kind}"
        )
        return {"kind": kind, "name": name}

    async def attachments(self) -> list[dict[str, Any]]:
        """What the runner will receive, as the hub lists it in the brief."""
        from flow_sdk.cloud_client.transport.hub_http import hub_get_or_raise  # noqa: PLC0415

        brief = await hub_get_or_raise(EntityType.DIAGNOSIS_REQUEST.value, self.id, "brief")
        return list(brief.get("attachments") or [])

    async def pull(self) -> "DiagnosisRequest":
        """Refresh the hub-owned fields (the latest run, the tally, the budget) into the local row."""
        from flow_sdk.cloud_client.transport.hub_http import hub_get_or_raise  # noqa: PLC0415

        row = await hub_get_or_raise(EntityType.DIAGNOSIS_REQUEST.value, self.id)
        changed = False
        for field in _HUB_FIELDS:
            if field in row and getattr(self, field) != row[field]:
                setattr(self, field, row[field])
                changed = True
        if changed:
            await self.save()
        return self

    @classmethod
    async def take_hub_update(cls, request_id: str, data: dict) -> bool:
        """The hub pushed this request's row (``notify_owner``, on every run that comes back): when
        it counts a run the local row has not seen, refresh the row and post a Home-feed entry that
        opens the request. Returns whether a new run was taken.

        Keyed on ``run_count``, so a frame repeated -- or one sent for a change that is not a run --
        posts nothing; serialized per request so two frames for one run post once.
        """
        from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus  # noqa: PLC0415
        from flow_sdk.server.routes.bootstrap import get_or_create_local_user  # noqa: PLC0415

        async with keyed_loop_lock(_update_locks, str(request_id)):
            request = await cls.get_one({"id": request_id})
            hub_count = int(data.get("run_count") or 0)
            if request is None or hub_count <= int(request.run_count or 0):
                return False
            await request.pull()
            user = await get_or_create_local_user()
            await FeedEntry(
                feed_status=FeedStatus.NEW.value, data={"type_id": str(request.typeid), "run": hub_count}
            ).save(user.typeid)
            return True

    async def runs(self, number: int | None = None) -> Any:
        """Every kept run (``number`` None), or one run whole, files included -- read from the hub."""
        from flow_sdk.cloud_client.transport.hub_http import hub_get_or_raise  # noqa: PLC0415

        await self.pull()
        if number is not None:
            return await hub_get_or_raise(EntityType.DIAGNOSIS_REQUEST.value, self.id, "runs", str(number))
        listed = await hub_get_or_raise(EntityType.DIAGNOSIS_REQUEST.value, self.id, "runs")
        return listed if isinstance(listed, list) else []  # an empty list arrives as ``{}``


def _title_of(instructions: str) -> str:
    """The request's label: the first line of its instructions."""
    return (instructions.strip().splitlines() or ["Diagnosis request"])[0][:80]


#: What the Assets sidebar shows of a request -- read from the hub, never from a local index.
_LISTED_FIELDS = ("id", "title", "name", "run_count", "last_run_at", "write_expires_at")


async def mine() -> list[dict[str, Any]]:
    """The requests this user may read, as the hub lists them -- the Assets sidebar's rows.

    A request has no file on disk for the indexer to read, so it is not a default-indexed type;
    like ``llm_endpoint`` it is listed from the hub, which owns its runs and their tally anyway.
    The hub does not keep the project a request was opened under, so each row takes its
    ``project_id`` from this computer's copy (``None`` for one opened elsewhere).
    """
    from flow_sdk.cloud_client.transport.hub_http import hub_get_or_raise  # noqa: PLC0415

    rows = await hub_get_or_raise(EntityType.DIAGNOSIS_REQUEST.value)
    listed = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or not row.get("id"):
            continue
        local = await DiagnosisRequest.get_one({"id": str(row["id"])})
        listed.append({**{k: row.get(k) for k in _LISTED_FIELDS}, "project_id": getattr(local, "project_id", None)})
    return sorted(listed, key=lambda r: str(r.get("last_run_at") or ""), reverse=True)


async def funding_sources() -> dict[str, Any]:
    """What the owner may fund a request from: the hub's answer (which budgets they may hand out,
    and whom to ask for the rest) plus the keys stored on this computer that the hub can take."""
    from flow_sdk.cli.auth.lm_api_keys import list_lm_api  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import hub_get_or_raise  # noqa: PLC0415

    hub = await hub_get_or_raise(EntityType.DIAGNOSIS_REQUEST.value, None, "funding_sources")
    keys = [
        {"provider": row["provider"], "uploads_to_hub": True}
        for row in list_lm_api()
        if row.get("configured") and not row.get("managed") and row.get("provider") in HUB_KEY_PROVIDERS
    ]
    return {"hub": hub if isinstance(hub, list) else [], "local_keys": keys}


async def _pack_asset(asset_typeid: str) -> tuple[str, str, bytes]:
    """``(kind, file name, bytes)`` for a Flowpad asset: a skill is ``skills/<name>.zip`` (installed
    into the run's ``.claude/skills``); another folder asset is ``files/<name>.zip``; a file asset is
    the file itself. Located and copied the way a message attachment is (same ignore rules)."""
    import asyncio  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415

    from flow_sdk.assets.transfer import pack_tree  # noqa: PLC0415
    from flow_sdk.builtin.faas.compute_node import build_dir_zip  # noqa: PLC0415
    from flow_sdk.builtin.flow_message_bundle import _resolve_file_backed_source  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    typeid = TypeId(asset_typeid)
    if typeid.type not in ATTACHABLE_ASSET_TYPES:
        raise ValueError(f"a {typeid.type} cannot be sent with a diagnosis request")
    resolved = await _resolve_file_backed_source(typeid.type, typeid.id)
    src_root = resolved[2] if resolved else None
    if src_root is None:
        raise ValueError(f"{asset_typeid} has no files on this computer to send")
    src_root = Path(src_root)
    kind = "skills" if typeid.type == EntityType.SKILL.value else "files"
    if not src_root.is_dir():
        return kind, src_root.name, src_root.read_bytes()
    with tempfile.TemporaryDirectory(prefix="diagnosis-attach-") as tmp:
        staged = Path(tmp) / src_root.name
        pack_tree(src_root, staged, type_name=typeid.type)
        archive = await asyncio.to_thread(build_dir_zip, str(staged))
    return kind, f"{src_root.name}.zip", archive.getvalue()


async def _hub_root_for_local_key(provider: str) -> str:
    """A hub root endpoint holding THIS computer's ``provider`` key -- reused if one was made before."""
    from flow_sdk.cli.app_config import get_user  # noqa: PLC0415
    from flow_sdk.cli.auth.lm_api_keys import get_lm_api  # noqa: PLC0415
    from flow_sdk.cloud_client.transport.hub_http import hub_get, hub_post  # noqa: PLC0415

    if provider not in HUB_KEY_PROVIDERS:
        raise ValueError(f"the hub cannot hold a {provider} key")
    key = get_lm_api(provider)
    if not key:
        raise ValueError(f"no {provider} key is stored on this computer")
    name = f"{provider} key (uploaded for diagnosis requests)"
    # Reused only when THIS user created it: ``created_by`` is stamped by the hub from the token,
    # so it cannot be forged. Matching on the name alone would pick up an endpoint someone else
    # named the same and shared here -- and its base_url would carry the runner's traffic.
    me = str((get_user() or {}).get("id") or "")
    existing = await hub_get(EntityType.LLM_ENDPOINT.value) or []
    for row in existing if isinstance(existing, list) else []:
        mine = bool(me) and str(row.get("created_by") or "") == me
        if mine and row.get("name") == name and row.get("provider") == provider:
            return f"{EntityType.LLM_ENDPOINT.value}-{row['id']}"
    created = await hub_post(EntityType.LLM_ENDPOINT.value, {"name": name, "provider": provider})
    endpoint_id = str((created or {}).get("id") or "")
    if not endpoint_id:
        raise ValueError("the hub did not create the endpoint")
    await hub_post(EntityType.LLM_ENDPOINT.value, {"key": key}, endpoint_id, "credential")
    return f"{EntityType.LLM_ENDPOINT.value}-{endpoint_id}"
