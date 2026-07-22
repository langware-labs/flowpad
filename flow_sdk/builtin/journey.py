"""Journey — a folder-backed guided-onboarding document (a FlowDoc dialect).

A Journey is the same folder/graph shape as an AgenticFlow (so it runs on the
same FlowManager engine, unchanged), but typed separately so it stays out of
the user's Flows list. Its graph is a mostly-linear sequence of ``guided_step``
nodes: each PRESENTS a place in the app (a standard dock pointer + optional
wiki-word highlight) and PARKS the run until the frontend orchestrator observes
the step's standard signal and injects its ``done``.

Folder layout::

    <scope>/.claude/journeys/<name>/
        graph.json      # the journey document (guided_step nodes + edges)
        display.json    # canvas layout only
        runs/           # execution journals (one JSONL per run)
        *.html          # child assets shown DURING the journey (page1.html …)

Progress is NOT stored here — it lives per-user in a JourneyJournal entity, so
one shared authored Journey keeps every user's progress private.
"""
import logging
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.journey_journal import JourneyJournal
    from flow_sdk.flow_manager.flow_doc import FlowDoc, FlowNodeDef

logger = logging.getLogger(__name__)

GUIDED_STEP = "guided_step"


def journeys_home_dir() -> Path:
    """Default location for user-scope journeys (the indexer walker scans this)."""
    return Path.home() / ".claude" / "journeys"


# ── graph helpers — the linear projection over guided_step nodes ──────────────

def guided_nodes(doc: "FlowDoc") -> list["FlowNodeDef"]:
    return [n for n in doc.nodes if n.node_type == GUIDED_STEP]


def entry_node(doc: "FlowDoc") -> str:
    """The first guided_step — the one no edge targets (the journey start)."""
    guided = guided_nodes(doc)
    targeted = {e.to_node for e in doc.edges}
    for n in guided:
        if n.id not in targeted:
            return n.id
    return guided[0].id if guided else ""


def next_guided(doc: "FlowDoc", node_id: str, event: str) -> Optional[str]:
    """The next guided_step reached from ``node_id`` on ``event`` (skip falls back
    to the ``done`` edge when the author didn't wire a dedicated skip edge)."""
    for target in doc.targets_for(node_id, event):
        if target.node_type == GUIDED_STEP:
            return target.id
    if event != "done":
        for target in doc.targets_for(node_id, "done"):
            if target.node_type == GUIDED_STEP:
                return target.id
    return None


async def park_run(journey_id: str, node_id: str) -> str:
    """Best-effort: start a run parked at ``node_id`` (supplies the one-liner).
    Never fails the caller — the journal is the durable cursor, the run is not."""
    if not node_id:
        return ""
    try:
        from flow_sdk.flow_manager import get_flow_manager

        fe = await get_flow_manager().inject(journey_id, "start", target_node=node_id)
        return fe.execution_id if fe else ""
    except Exception:
        logger.debug("Journey: park run failed", exc_info=True)
        return ""


async def _run_is_live(run_id: str) -> bool:
    if not run_id:
        return False
    try:
        from flow_sdk.flow_manager import get_flow_manager

        return run_id in get_flow_manager().live_run_ids()
    except Exception:
        return False


class Journey(Entity):
    type: str = APIField(default=EntityType.JOURNEY.value)
    name: str = APIField(default="")
    description: str = APIField(default="")
    asset_ref: str = APIField(default="")
    enabled: bool = APIField(default=True, description="The journey's active switch.")
    auto_launch: bool = APIField(
        default=False,
        description="Launch this journey on project load (loader redirects to ?journeyId=).",
    )

    _api_visible: ClassVar[bool] = True

    @property
    def folder(self) -> Optional[Path]:
        return Path(self.asset_ref) if self.asset_ref else None

    # ── the journey interface — every method returns the JOURNAL ──────────────
    #
    # The journal IS the progress object (cursor / status / steps_left / entries).
    # Step DESCRIPTORS are not returned here: read them from this folder's
    # graph.json and derive done/current/upcoming from cursor + entries.

    def auto_launch_enabled(self) -> bool:
        """The `auto_launch` flag, read straight from graph.json.

        Read from disk rather than the `auto_launch` column because record
        metadata is not synced onto entity fields — disk stays the truth, same as
        every other journey property."""
        import json  # noqa: PLC0415

        if not self.asset_ref:
            return bool(self.auto_launch)
        try:
            raw = json.loads((Path(self.asset_ref) / "graph.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return bool(self.auto_launch)
        return bool(raw.get("auto_launch", self.auto_launch))

    @staticmethod
    async def auto_launch_for(user_id: str) -> Optional["Journey"]:
        """The journey to enter on project load, or None.

        A journey the user already completed is never re-entered."""
        from flow_sdk.builtin.journey_journal import JourneyStatus

        for journey in await Journey.get_all({}):
            if not journey.enabled or not journey.auto_launch_enabled():
                continue
            current = await journey.progress(user_id)
            if current is not None and current.status == JourneyStatus.COMPLETE.value:
                continue
            return journey
        return None

    def doc(self) -> Optional["FlowDoc"]:
        """This journey's parsed graph.json (disk is truth)."""
        from flow_sdk.flow_manager.flow_doc import parse_flow_doc

        if not self.asset_ref:
            return None
        try:
            return parse_flow_doc((Path(self.asset_ref) / "graph.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    async def _journals(self, user_id: str) -> list["JourneyJournal"]:
        """This user's journals for this journey, newest-first."""
        from flow_sdk.builtin.journey_journal import JourneyJournal

        rows = await JourneyJournal.get_all({"journey_id": self.id})
        mine = [j for j in rows if (j.user_id or "") == user_id]
        mine.sort(key=lambda j: str(getattr(j, "created_date", "") or ""), reverse=True)
        return mine

    async def _active(self, user_id: str) -> Optional["JourneyJournal"]:
        """The single active (new|launched) journal, or None — the invariant."""
        return next((j for j in await self._journals(user_id) if j.is_active), None)

    async def progress(self, user_id: str) -> Optional["JourneyJournal"]:
        """The active journal, else the most recent one, else None (never launched)."""
        journals = await self._journals(user_id)
        return next((j for j in journals if j.is_active), journals[0] if journals else None)

    async def launch(self, user_id: str) -> Optional["JourneyJournal"]:
        """Idempotent: return the active journal, else start a fresh one at the entry."""
        from flow_sdk.builtin.journey_journal import JourneyJournal, JourneyStatus
        from flow_sdk.fs_store.identifier import mint_uuid

        active = await self._active(user_id)
        if active is not None:
            return active
        doc = self.doc()
        if doc is None:
            return None
        entry = entry_node(doc)
        total = len(guided_nodes(doc))
        journal = JourneyJournal(
            id=mint_uuid(), journey_id=self.id, user_id=user_id,
            status=JourneyStatus.NEW.value, run_id=await park_run(self.id, entry),
            cursor=entry, total_steps=total, steps_left=total, entries=[],
        )
        await journal.save()
        return journal

    async def restart(self, user_id: str) -> Optional["JourneyJournal"]:
        """Archive the active journal (→ restarted) and launch a fresh one.
        A `complete` journal is left untouched — it stays in history as complete."""
        from flow_sdk.builtin.journey_journal import JourneyStatus

        active = await self._active(user_id)
        if active is not None:
            active.status = JourneyStatus.RESTARTED.value
            await active.update()
        return await self.launch(user_id)

    async def advance(self, user_id: str, node_id: str,
                      event: str = "done") -> Optional["JourneyJournal"]:
        """Record a step outcome and move the cursor. Idempotent: a stale
        ``node_id`` (cursor already moved) is a no-op."""
        from flow_sdk.builtin.journey_journal import JourneyStatus
        from flow_sdk.core.capabilities.models import now_iso

        journal = await self._active(user_id)
        if journal is None:
            return None
        if journal.cursor != node_id:
            return journal
        doc = self.doc()
        if doc is None:
            return journal

        # Advance the live run so its one-liner tracks (best effort).
        if await _run_is_live(journal.run_id):
            try:
                from flow_sdk.flow_manager import get_flow_manager

                await get_flow_manager().inject(
                    self.id, event, execution_id=journal.run_id, source_node=node_id)
            except Exception:
                logger.debug("Journey: advance inject failed", exc_info=True)

        journal.entries = [*journal.entries, {"node_id": node_id, "event": event, "at": now_iso()}]
        nxt = next_guided(doc, node_id, event)
        if nxt is None:
            journal.cursor = ""
            journal.status = JourneyStatus.COMPLETE.value
            journal.steps_left = 0
        else:
            journal.cursor = nxt
            journal.status = JourneyStatus.LAUNCHED.value
            journal.steps_left = max(0, journal.total_steps - len(journal.entries))
            if not await _run_is_live(journal.run_id):
                journal.run_id = await park_run(self.id, nxt)
        await journal.update()
        return journal

    async def history(self, user_id: str) -> list["JourneyJournal"]:
        """Every journal for this (user, journey), newest-first — all statuses."""
        return await self._journals(user_id)

    @staticmethod
    async def resume(journal_id: str, user_id: str) -> Optional["JourneyJournal"]:
        """Re-activate a past journal, archiving whichever one is active now."""
        from flow_sdk.builtin.journey_journal import JourneyJournal, JourneyStatus

        target = await JourneyJournal.get_by_id(journal_id)
        if target is None:
            return None
        journey = await Journey.get_by_id(target.journey_id)
        if journey is None:
            return None
        active = await journey._active(user_id)
        if active is not None and active.id != target.id:
            active.status = JourneyStatus.RESTARTED.value
            await active.update()
        target.status = (JourneyStatus.LAUNCHED.value if target.entries
                         else JourneyStatus.NEW.value)
        doc = journey.doc()
        target.run_id = await park_run(journey.id,
                                       target.cursor or (entry_node(doc) if doc else ""))
        await target.update()
        return target

    def materialize_folder(self) -> Path:
        """Create the folder + stub files for a fresh journey (idempotent)."""
        from flow_sdk.flow_manager.flow_doc import empty_flow_doc

        slug = (
            "".join(c if c.isalnum() or c in "-_" else "-" for c in (self.name or "journey")).strip("-")
            or "journey"
        )
        folder = Path(self.asset_ref) if self.asset_ref else journeys_home_dir() / slug
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "runs").mkdir(exist_ok=True)
        graph = folder / "graph.json"
        if not graph.exists():
            graph.write_text(empty_flow_doc(self.id or "", self.name), encoding="utf-8")
        display = folder / "display.json"
        if not display.exists():
            display.write_text('{"version": 1, "nodes": {}}\n', encoding="utf-8")
        if self.id:
            capsule = folder / ".flow"
            capsule.mkdir(exist_ok=True)
            id_file = capsule / "id"
            if not id_file.exists():
                id_file.write_text(self.id, encoding="utf-8")
        self.asset_ref = str(folder)
        return folder

    async def save(self, *args, **kwargs):  # type: ignore[override]
        result = await super().save(*args, **kwargs)
        try:
            prev_ref = self.asset_ref
            self.materialize_folder()
            if self.asset_ref != prev_ref:
                await self.update()
        except Exception:
            import logging

            logging.getLogger(__name__).exception("Journey: folder scaffold failed")
        return result
