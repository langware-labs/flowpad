"""DynamicWorkflow entity — an authored dynamic-workflow script asset.

The *definition* a user writes (Workflow-tool JS: ``export const meta`` + an
``agent()``/``parallel()``/``pipeline()`` body), like an Agent or a Skill. It is
creatable and editable; running it produces a WORKFLOW_RUN (a separate run
journal/transcript). Backed by ``<root>/.claude/workflows/<name>.js``.

Auto-registered via Entity.__init_subclass__ so Entity.from_record() uses this
class for dynamic_workflow records.
"""

from __future__ import annotations

from typing import Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class DynamicWorkflow(Entity):
    type: str = APIField(default=EntityType.DYNAMIC_WORKFLOW.value)
    name: str = APIField("")
    description: str = APIField("", description="From the script's meta.description")
    asset_ref: Optional[str] = APIField(None, description="Path to the .js workflow script", sharing=Sharing.PRIVATE)
