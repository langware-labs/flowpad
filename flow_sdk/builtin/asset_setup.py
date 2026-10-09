"""AssetSetup — a DECLARED node of the setup tree: the row, and how to read the document.

Folder layout::

    <scope>/agentic-assets/asset_setup/<name>/asset_setup.json

Most setup nodes are derived (a project's credentials, its sources, its web apps — ``core/setup/derive``);
a declaration adds what a derivation cannot know: a source's container, a wizard to run before a
project's children. Disk is the truth — ``spec()`` re-reads the document — the contract every entity
document keeps.
"""

import logging
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.schema.data_spec.asset_setup_spec import AssetSetupSpec

logger = logging.getLogger(__name__)

#: The main document. ``asset_ref`` is the FOLDER, so every read joins this.
MAIN = "asset_setup.json"


class AssetSetup(Entity):
    """The row mirrors the document field for field; ``spec()`` is the truth."""

    type: str = APIField(default=EntityType.ASSET_SETUP.value)
    name: str = APIField(default="")
    label: str = APIField(default="", description="What a person calls this setup.")
    subject: str = APIField(default="", description="The asset this node sets up; empty = the asset holding it.")
    children: list[str] = APIField(default_factory=list, description="Nodes set up before this one's run.")
    prepare: str = APIField(default="", description="The wizard run before the children.")
    run: str = APIField(default="", description="The wizard run once every child is set up.")
    inputs: dict[str, str] = APIField(default_factory=dict, description="Values put in scope for its wizards.")
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)

    _api_visible: ClassVar[bool] = True

    @classmethod
    async def by_name(cls, name: str) -> Optional["AssetSetup"]:
        """The node named ``name``, or None — this install's copy when a project shadows it."""
        from flow_sdk.builtin.shipped_lookup import by_name_preferring_this_install  # noqa: PLC0415

        return await by_name_preferring_this_install(cls, name)

    def spec(self) -> Optional["AssetSetupSpec"]:
        """The parsed document, or ``None`` when it is missing or malformed."""
        from flow_sdk.assets.entity_document import read_entity_document  # noqa: PLC0415
        from flow_sdk.schema.data_spec.asset_setup_spec import AssetSetupSpec  # noqa: PLC0415

        if not self.asset_ref:
            return None
        main = Path(self.asset_ref)
        if main.is_dir():
            main = main / MAIN
        try:
            return AssetSetupSpec.model_validate(read_entity_document(main).fields)
        except Exception as error:  # a bad document is "no node here", never a wedged setup
            logger.warning("asset_setup %s is unreadable: %s", self.name or self.asset_ref, error)
            return None

    def is_system(self) -> bool:
        """Shipped inside an SDK system project — the trust boundary every runnable asset keeps."""
        from flow_sdk.config import is_system_project_path  # noqa: PLC0415

        if not self.asset_ref:
            return False
        return any(is_system_project_path(p) for p in Path(self.asset_ref).parents)
