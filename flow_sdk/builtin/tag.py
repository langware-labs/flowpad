"""Tag — OPTIONAL enrichment of a dot-taxonomy tag name ("blessing").

A tag is fundamentally just a validated string (``flow_sdk/tags/grammar``);
the whole system works with anonymous tags — the bus routes them, kind
fields carry them, nothing requires a row. A Tag entity exists only where a
name deserves documentation, display, namespace ownership, or hub sync.

Identity is the name: ``id = mint_uuid("tag:<canonical name>")`` (uuid5), so
blessing the same name on any instance — or long after the name was first used
anonymously — always converges on the same entity (hub sync dedupes for free).
The taxonomy graph is DERIVED from dot-paths (``grammar.tag_tree``); no
edges are ever stored.

Resolution is wiki-link-style (``resolve_tag`` → entity or None) and NEVER
mints: blessing is a deliberate act (author, UI, seeder) — an event storm on
the bus must not become an entity storm.

CRUD is generic (``POST/GET /graph/tag`` via the catch-all router); no
bespoke actions.
"""

from __future__ import annotations

import uuid
from contextvars import ContextVar
from typing import Any, Optional

from pydantic import field_validator

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType
from flow_sdk.tags.grammar import normalize_tag


class Tag(Entity):
    """A blessed dot-taxonomy tag whose canonical ``name`` is its natural key."""

    type: str = APIField(default=EntityType.TAG.value)
    name: str = APIField(description="Canonical dot-separated tag name")
    title: Optional[str] = APIField(default=None, description="UX display label")
    description: Optional[str] = APIField(default=None, description="What events/things under this tag mean")
    # Rename seam: renames never mutate identity (name IS identity) — the old
    # tag stays, deprecated, pointing at its successor.
    alias_of: Optional[str] = APIField(default=None, description="Canonical successor name when this tag was renamed")
    deprecated: bool = APIField(default=False, description="Hidden from authoring surfaces")
    # NOTE: the `system` display flag is the BASE Entity field (entity_model
    # `system: bool` APIField). Because every APIField is client-writable via
    # generic CRUD, that flag carries NO authority — the reserved-root gate
    # below keys on in-process seeding provenance (`_seeding`), never on the
    # field. `save()` also re-derives the flag on new rows so a client cannot
    # even display-spoof it.

    def __init__(self, **data: Any) -> None:
        # allocate_id normalizes the name it mints from; the field validator
        # canonicalizes the stored field on every path (incl. model_validate,
        # which bypasses this __init__). No third normalize needed here.
        data["id"] = self.allocate_id(data)
        super().__init__(**data)

    @field_validator("name", mode="before")
    @classmethod
    def _canonical_name(cls, value: Any) -> str:
        # Strict gate on EVERY construction path (direct init, model_validate,
        # from_record): entities adopt only canonical names — the bus stays
        # permissive and anonymous tags are never validated there.
        return normalize_tag(value)

    async def save(self, owner=None, notify: bool = True) -> "Tag":
        """Reserved-root gate on NEW rows: only in-process seeding may create a
        tag under a system-owned first segment. Provenance is the `_seeding`
        contextvar — never a model field, since every API field is
        client-writable through generic CRUD. Existing rows (created_by set,
        e.g. hub-synced updates) pass through. The BUS never checks — this
        guards entity adoption only, routing stays taxonomy-free."""
        if not self.created_by:  # new row
            seeding = _seeding.get()
            root = self.name.split(".", 1)[0]
            if root in RESERVED_ROOTS and not seeding:
                raise ValueError(
                    f'"{root}" is a reserved system root — user tags belong under '
                    f"a --<namespace>-- prefix or a non-reserved root"
                )
            # Display flag derives from provenance on creation (no spoofing).
            self.system = seeding
        return await super().save(owner=owner, notify=notify)

    @classmethod
    def allocate_id(cls, data: dict) -> str:
        """Name-derived uuid5 — the same name always mints the same id.

        A caller-supplied id never overrides the natural key. Hub/materialized
        copies converge on the same deterministic id; a nameless construction
        falls back to uuid4 (and is rejected later by field validation).
        """
        from flow_sdk.fs_store.identifier import mint_uuid

        name = data.get("name") or ""
        if name:
            return mint_uuid(f"tag:{normalize_tag(name)}", namespace=uuid.NAMESPACE_DNS)
        return mint_uuid()


# The shipped system vocabulary — (name, title, description) tuples, seeded as
# ordinary Tag entities at boot (the catalog IS the entities; there is no
# separate registry). Idempotent by construction: ids are uuid5(name), so
# re-seeding upserts in place and never touches user tags. Intermediate
# nodes (e.g. ``flow.step``) are derived by ``grammar.tag_tree`` — only
# roots and real leaves are blessed here. Dynamic vocabularies (``gcp.*``
# provider kinds, ``app.ui.<kind>.clicked``) stay anonymous by design.
SYSTEM_TAG_SEED: tuple[tuple[str, str, str], ...] = (
    # ── event families ──
    ("entity", "Entity events", "Local entity lifecycle events (data ops)"),
    ("entity.created", "Entity created", "An entity row was created"),
    ("entity.updated", "Entity updated", "An entity row was updated"),
    ("entity.deleted", "Entity deleted", "An entity row was deleted"),
    ("hub", "Hub events", "Events originating from the hub connection"),
    ("hub.entity.created", "Hub entity created", "A hub-synced entity was created"),
    ("hub.entity.updated", "Hub entity updated", "A hub-synced entity was updated"),
    ("hub.entity.deleted", "Hub entity deleted", "A hub-synced entity was deleted"),
    ("node", "Node connection", "Cloud/compute node connection transitions"),
    ("node.connected", "Node connected", "The cloud connection came up"),
    ("node.connecting", "Node connecting", "The cloud connection is being established"),
    ("node.disconnected", "Node disconnected", "The cloud connection dropped"),
    ("agent", "Agent events", "Agentic-process lifecycle events"),
    ("agent.status", "Agent status", "An agentic process changed status"),
    ("graph_workflow", "Graph workflow lifecycle", "Graph-workflow run boundary events"),
    ("graph_workflow.started", "Graph workflow started", "A graph-workflow run started"),
    ("graph_workflow.step.done", "Graph workflow step done", "A graph-workflow node finished"),
    ("graph_workflow.output", "Graph workflow output", "A graph workflow produced an output"),
    ("graph_workflow.waiting", "Graph workflow waiting", "A graph-workflow run is waiting (guided step)"),
    ("graph_workflow.done", "Graph workflow done", "A graph-workflow run completed"),
    ("graph_workflow.failed", "Graph workflow failed", "A graph-workflow run failed"),
    ("graph_workflow.run.event", "Graph workflow run event",
     "One beat of a run's internal stream (kind: run_start | event | run_end)"),
    ("graph_workflow.node.status", "Graph workflow node status",
     "A scheduler transition for one node (queued | merged | started | finished | failed | waiting)"),
    ("app", "App events", "Frontend-emitted events (app tier)"),
    ("app.ui", "UI interactions", "Clicks on tag-tagged UI elements"),
    ("app.route.loaded", "Route loaded", "A dock navigation completed"),
    ("app.page.signal", "Page signal", "A sandboxed page posted a journey signal"),
    ("app.entity.created", "Entity created (app)", "App-tier mirror of entity.created"),
    ("app.entity.updated", "Entity updated (app)", "App-tier mirror of entity.updated"),
    ("app.entity.deleted", "Entity deleted (app)", "App-tier mirror of entity.deleted"),
    ("app.journey.act.done", "Journey act done", "A journey act completed"),
    ("app.journey.act.failed", "Journey act failed", "A journey act failed"),
    ("ingest", "Ingestion events", "Data-source ingestion (ingest.<provider>.<layer>.<verb>)"),
    # ── kind ontology ──
    ("application", "Applications", "Deployable application compositions"),
    ("application.web", "Web application", "A web app (folder or checkout that serves)"),
    ("workload", "Workloads", "Running compute shapes"),
    ("workload.service", "Service", "A long-running service"),
    ("workload.service.http", "HTTP service", "A long-running HTTP service"),
    ("workload.job", "Job", "A run-to-completion workload"),
    ("workload.function", "Function", "A function-as-a-service workload"),
    ("resource", "Resources", "Provisioned infrastructure resources"),
    ("resource.infrastructure", "Infrastructure", "General cloud infrastructure"),
    ("resource.database.postgresql", "PostgreSQL", "A PostgreSQL database"),
    ("resource.queue", "Queue", "A message queue"),
    ("resource.storage.object", "Object storage", "An object-storage bucket"),
    ("content", "Content", "Files and data artifacts"),
    ("content.file", "File", "A generic file artifact"),
    ("content.file.text", "Text file", "A text file artifact"),
    ("content.data", "Data", "A structured-data artifact"),
    ("content.web.page", "Web page", "A static web page artifact"),
    ("content.feed.item", "Feed item", "One entry ingested from a feed or API data source"),
    ("datasource", "Data sources", "External systems of record synced from (datasource.<modality>.<provider>)"),
    ("datasource.feed.rss", "RSS/Atom feed", "A syndication feed polled on a schedule"),
    ("datasource.api.hackernews", "Hacker News", "The Hacker News Firebase API"),
    ("gcp", "GCP", "Provider-minted GCP resource kinds (gcp.<service>.<resource>)"),
    ("local", "Local runtime", "Locally-hosted runtime placements"),
    ("local.runtime.web", "Local web runtime", "A locally-served web app deployment"),
)

# System-owned first segments — the our-world / user-world boundary, DERIVED
# from the seed so adding a system family automatically reserves its root.
# A non-system actor may not create (or rename to) a tag under one of these.
# Policy lives here with the entity; the grammar stays policy-free and the BUS
# never checks (routing stays taxonomy-free). TS mirror:
# ts_sdk/src/entities/tag.ts RESERVED_TAG_ROOTS, pinned by the
# ``reserved_roots`` section of tests/fixtures/flow_event_contract.json.
RESERVED_ROOTS = frozenset(name.split(".", 1)[0] for name, _t, _d in SYSTEM_TAG_SEED)

# In-process seeding provenance: True only inside seed_system_tags. The
# reserved-root gate reads THIS, never a model field (fields are
# client-writable via generic CRUD).
_seeding: ContextVar[bool] = ContextVar("tag_seeding", default=False)


async def seed_system_tags() -> int:
    """Upsert the shipped vocabulary as system Tag entities. Idempotent:
    uuid5 ids make re-runs converge; only changed title/description rows are
    rewritten; user tags are never touched. Returns rows written."""
    written = 0
    token = _seeding.set(True)
    try:
        for name, title, description in SYSTEM_TAG_SEED:
            expected = Tag(name=name, title=title, description=description, system=True)
            existing = await Tag.get_by_id(expected.id)
            if existing is not None and (
                existing.title == title and existing.description == description and existing.system
            ):
                continue
            await expected.save(notify=False)
            written += 1
    finally:
        _seeding.reset(token)
    return written


async def resolve_tag(name: str) -> Optional[Tag]:
    """Wiki-link-style resolution: the blessed Tag for ``name``, or None.

    None is a fully supported state (anonymous tag), not an error. NEVER
    mints — callers wanting to bless a tag create the entity deliberately.
    """
    try:
        canonical = normalize_tag(name)
    except (TypeError, ValueError):
        return None
    return await Tag.get_by_id(Tag.allocate_id({"name": canonical}))
