"""WebApp — the DEFINITION of a web app: a ``webapp.json`` folder asset.

What an app IS lives here — its name, what it is for, the folder it is built
into, which web audience it is for and where it mounts (``mounts``), and the APIs it
brings along (``services``). How it is SERVED is not a fact about the app: every place
it runs is a ``Deployment``, whose ``admin`` and ``app`` endpoints are the two proxies
its web apps are routes of (a route's ``webapp_id`` names this row). Indexing a webapp
gives it a ``static`` route on its project's local placement
(``webapp_placement.place_webapp_locally``); that route is how the app is displayed
and reached.
"""

from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar, List, Optional

from pydantic import computed_field

from flow_sdk.api.api_types.api_field import APIField, EntityField, Sharing
from flow_sdk.core import Entity, action
from flow_sdk.core.setup.skip_mark import SetupSkippable
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.schema.data_spec.asset_setup_spec import SetupSkipSpec
from flow_sdk.schema.data_spec.webapp_spec import WebappMountSpec, WebappServiceSpec, WebappViewSpec
from flow_sdk.worldview.ontology import KindStr


class WebApp(SetupSkippable, Entity):
    type: str = APIField(default=BuiltinEntityType.MICRO_APP.value)
    project_id: Optional[str] = APIField(default=None, description="Owning project", sharing=Sharing.PRIVATE)
    #: The app FOLDER on disk, stamped by the indexer. A plain string, not an
    #: FSRef — same shape as ``Dataset.asset_ref``.
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
    #: Skipped in its project's setup on THIS machine (``SetupSkipSpec``, ``core/setup/skip_mark``). PRIVATE.
    setup_skipped: Optional[SetupSkipSpec] = APIField(default=None, sharing=Sharing.PRIVATE)
    description: Optional[str] = APIField(default=None, description="What the app is, for the asset browser")
    kind: KindStr = APIField(default="application.web", description="Dot-path ontology kind")
    #: What an editor edits beyond its parent: kinds and type names (``flow_sdk.builtin.faas.editors``).
    edits: List[str] = APIField(default_factory=list, description="Kinds and types this editor edits")
    #: What a viewer shows: kinds, single and/or collection (``flow_sdk.builtin.faas.editors``).
    views: List[WebappViewSpec] = APIField(default_factory=list, description="Kinds this viewer shows")
    module: str = APIField(default="viewer.js", description="A viewer's ES module, inside the served folder")
    build: str = APIField(default=".", description="Served subdir inside the app folder")
    #: How the app is served to a web audience when placed — the templates a placement turns into
    #: ROUTES of its ``admin`` / ``app`` proxy (``webapp_placement``).
    mounts: List[WebappMountSpec] = APIField(default_factory=list, description="How the app is served when placed")
    #: The machine-called services the app brings along, each a ``service`` endpoint of its own.
    services: List[WebappServiceSpec] = APIField(default_factory=list, description="APIs the app brings along")
    #: Report the page's JS errors while it loads (``server/reporter_relay.py``); off loads the dev server directly.
    report_errors: bool = APIField(default=True, description="Report page errors to Flowpad while the app loads")

    name: str = EntityField(sharing=Sharing.SHARED)
    # NOT unique: identity is ``id``, name is a label — the second app anyone
    # names "frontend" must still save.
    _unique: ClassVar[List[str]] = []

    async def reconcile_name(self) -> SimpleNamespace:
        """A tab showing the app is labelled by its title ("Sales Desk"), else its folder name —
        always, like a chat tab follows its chat (``Tab.reconcile_target_name``)."""
        return SimpleNamespace(name=(self.title or "").strip() or self.name)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def lifecycle(self) -> Optional[dict]:
        """THE record of this app on this machine (``core/webapp/record``), read from its instance file on every
        serialization — never stored on the row, so a GET and a push always carry the current one."""
        if not getattr(self, "id", None) or not self.asset_ref:
            return None
        try:
            from flow_sdk.core.webapp import record  # noqa: PLC0415

            return record.read(str(self.id), self.project_id or "").model_dump(mode="json")
        except Exception:  # noqa: BLE001 — a record that cannot be read is no record, never a broken row
            return None

    def is_file_backed(self) -> bool:
        """A row with no folder is a delivery row from before endpoints — DB-only,
        so dropping it (``webapp_placement.prune_delivery_rows``) never touches disk."""
        return bool(self.asset_ref)

    def on_disk(self) -> bool:
        """A file-backed app whose folder is gone is a stale row -- never offered, never set up."""
        return not self.is_file_backed() or Path(self.asset_ref).is_dir()

    # ── setup: the Setup tab of the app editor ──────────────────────────────

    @action.get(action_name="setup-state")
    async def setup_state_action(self):
        """``GET micro_app/<id>/setup-state`` — the app's ``setup/`` folder: handlings, recovery.md, failure log,
        and its lifecycle record on this machine."""
        from flow_sdk.builtin import webapp_check  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        if not self.asset_ref:
            return ApiFailResponse(message="this app has no folder", status_code=409)
        return ApiSuccessResponse(data=webapp_check.setup_state(self.asset_ref, str(self.id)))

    @action.post(action_name="setup-rule")
    async def setup_rule_action(self, rule: str = "", rule_action: str = ""):
        """``POST micro_app/<id>/setup-rule`` — turn one learned handling to another action."""
        from flow_sdk.builtin import webapp_check  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        if not self.asset_ref or not webapp_check.set_rule_action(self.asset_ref, rule, rule_action):
            return ApiFailResponse(message="no such handling, or not an action", status_code=400)
        return ApiSuccessResponse(data=webapp_check.setup_state(self.asset_ref, str(self.id)))

    # ── lifecycle: THE record and THE way up (core/webapp) ──────────────────

    @action.get(action_name="lifecycle")
    async def lifecycle_action(self):
        """``GET micro_app/<id>/lifecycle`` — the app's record on this machine (``webapp.lifecycle``)."""
        from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

        return ApiSuccessResponse(data=self.lifecycle)

    @action.post(action_name="up")
    async def up_action(self, display: str = "", wait: bool = False):
        """``POST micro_app/<id>/up`` — bring the app up (``core/webapp/coordinator.bring_up``); answers its record."""
        from flow_sdk.core.webapp import coordinator  # noqa: PLC0415
        from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

        rec = await coordinator.bring_up(self, display=display, reason="open", wait=wait)
        return ApiSuccessResponse(data=rec.model_dump(mode="json"))

    @action.post(action_name="fix")
    async def fix_action(self, display: str = ""):
        """``POST micro_app/<id>/fix`` — a person's Fix it: bring the app up again; the fixer may run again."""
        from flow_sdk.core.webapp import coordinator  # noqa: PLC0415
        from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

        rec = await coordinator.bring_up(self, display=display, reason="fix")
        return ApiSuccessResponse(data=rec.model_dump(mode="json"))

    @action.post(action_name="stop")
    async def stop_action(self):
        """``POST micro_app/<id>/stop`` — stop the app's run and its processes on this machine."""
        from flow_sdk.core.webapp import coordinator  # noqa: PLC0415
        from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

        rec = await coordinator.stop(self)
        return ApiSuccessResponse(data=rec.model_dump(mode="json"))

    @action.post(action_name="handling")
    async def handling_action(self, handling: dict | None = None, fingerprint: str = ""):
        """``POST micro_app/<id>/handling`` — add a learned handling. ``fingerprint`` names the failure it was
        learned from (in the app's failure log, or its record); a handling that does not match it is refused."""
        from flow_sdk.core.webapp import handling as handlings  # noqa: PLC0415
        from flow_sdk.core.webapp import record  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415
        from flow_sdk.schema.data_spec.webapp_lifecycle_spec import WebappHandlingSpec  # noqa: PLC0415

        if not self.asset_ref:
            return ApiFailResponse(message="this app has no folder", status_code=409)
        proof = handlings.proof_of(self.asset_ref, fingerprint, record.read(str(self.id)))
        if proof is None:
            return ApiFailResponse(message=f"no failure with fingerprint {fingerprint!r} in this app's log",
                                   status_code=404)
        try:
            added = handlings.add(self.asset_ref, WebappHandlingSpec.model_validate(handling or {}), proof=proof)
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=422)
        return ApiSuccessResponse(data=added.model_dump(mode="json"))
