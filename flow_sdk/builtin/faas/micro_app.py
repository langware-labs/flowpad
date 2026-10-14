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
from typing import ClassVar, List, Optional

from flow_sdk.api.api_types.api_field import APIField, EntityField, Sharing
from flow_sdk.core import Entity
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

    name: str = EntityField(sharing=Sharing.SHARED)
    # NOT unique: identity is ``id``, name is a label — the second app anyone
    # names "frontend" must still save.
    _unique: ClassVar[List[str]] = []

    def is_file_backed(self) -> bool:
        """A row with no folder is a delivery row from before endpoints — DB-only,
        so dropping it (``webapp_placement.prune_delivery_rows``) never touches disk."""
        return bool(self.asset_ref)

    def on_disk(self) -> bool:
        """A file-backed app whose folder is gone is a stale row -- never offered, never set up."""
        return not self.is_file_backed() or Path(self.asset_ref).is_dir()
