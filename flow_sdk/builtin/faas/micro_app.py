"""WebApp — the DEFINITION of a web app: a ``webapp.json`` folder asset.

What an app IS lives here — its name, what it is for, the folder it is built
into and the services it exposes when placed (``endpoints``). How it is SERVED
is not a fact about the app: every place it runs is a ``Deployment``, and what
that placement answers on is a ``ServiceEndpoint`` (``webapp_id`` names this
row). Indexing a webapp gives it a ``static`` endpoint on its project's local
placement (``webapp_placement.place_webapp_locally``); that endpoint is how the
app is displayed and reached.
"""

from typing import ClassVar, List, Optional

from flow_sdk.api.api_types.api_field import APIField, EntityField, Sharing
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.schema.data_spec.webapp_spec import WebappEndpointSpec
from flow_sdk.worldview.ontology import KindStr


class WebApp(Entity):
    type: str = APIField(default=BuiltinEntityType.MICRO_APP.value)
    project_id: Optional[str] = APIField(default=None, description="Owning project", sharing=Sharing.PRIVATE)
    #: The app FOLDER on disk, stamped by the indexer. A plain string, not an
    #: FSRef — same shape as ``Dataset.asset_ref``.
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
    description: Optional[str] = APIField(default=None, description="What the app is, for the asset browser")
    kind: KindStr = APIField(default="application.web", description="Dot-path ontology kind")
    build: str = APIField(default=".", description="Served subdir inside the app folder")
    #: What the app exposes when placed — the templates a placement turns into
    #: ``ServiceEndpoint`` rows (``webapp_placement.expose_project_endpoints``).
    endpoints: List[WebappEndpointSpec] = APIField(
        default_factory=list, description="Services the app exposes when placed"
    )

    name: str = EntityField(sharing=Sharing.SHARED)
    # NOT unique: identity is ``id``, name is a label — the second app anyone
    # names "frontend" must still save.
    _unique: ClassVar[List[str]] = []

    def is_file_backed(self) -> bool:
        """A row with no folder is a delivery row from before endpoints — DB-only,
        so dropping it (``webapp_placement.prune_delivery_rows``) never touches disk."""
        return bool(self.asset_ref)
