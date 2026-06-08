"""Group — generic folder-like container entity (docs/entities-groups.md).

Pure organization: any entity may live in exactly one group via the base
``Entity.group_id`` field; a Group's own parent is that same inherited field,
so nesting needs no extra mechanism. A tree is identified by ``namespace``
(set at creation, immutable); the tree root is virtual (``group_id is None``).

This module is the generic "lower level": membership validation (shared with
the generic ``set-group`` action in ``entity_model``), cycle-checked ``move``,
and ``delete-group`` with move-children-up semantics. Listing needs no bespoke
endpoints — children/roots are ordinary entity queries through
``GET /graph/<type>?...`` (``$EQ group_id`` for children, ``$IS_NULL`` for
roots); the ts_sdk composes them.
"""
from __future__ import annotations

from typing import Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, action
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

# Upper bound for ancestor walks. Far deeper than any sane folder tree; exists
# so a corrupted parent chain (e.g. hand-edited records forming a loop) can
# never spin the validator.
MAX_GROUP_DEPTH = 64


class Group(Entity):
    type: str = APIField(default="group")
    name: str = APIField("")
    group_namespace: str = APIField(
        "",
        description=(
            "Tree identity (e.g. 'prompt-library'). Set at creation and "
            "immutable — a group never moves across trees. (Named "
            "group_namespace because bare ``namespace`` is a reserved "
            "unique-per-type base-entity column.)"
        ),
    )
    icon: Optional[str] = APIField(
        None, description="Lucide export name or emoji char (the UI's renderIconValue resolves either)."
    )
    color: Optional[str] = APIField(
        None, description="Hex color from the curated contrast-tested palette."
    )

    # ── legacy ACL compatibility ──────────────────────────────────────────────
    # ``Entity.grant_access_to_public_data`` (sharing/visibility) grants roles
    # against a well-known "public" group. That principal predates the folder
    # semantics; it lives outside every tree (``namespace == ""``) so it never
    # appears in any browseable namespace. Kept so workspace bootstrap and the
    # public-access role helpers keep working unchanged.

    @staticmethod
    async def get_public_group() -> "Group":
        public_entity = await Group.get_by_name("public")
        if not public_entity:
            public_entity = Group(name="public")
            await public_entity.save()
        return public_entity

    @staticmethod
    async def get_by_name(name: str = "public") -> Optional["Group"]:
        return await Group.get_one({"name": name})

    # ── membership rules (single source — set-group and move both call this) ──

    @staticmethod
    async def validate_membership(entity: Entity, group_id: str | None) -> str | None:
        """Why may ``entity`` not be placed under ``group_id``? None = allowed.

        Invariants (docs/entities-groups.md): target must exist; entity and
        target share a project when both declare one; a group only re-parents
        within its own namespace; no cycles (a group never moves under its own
        descendant). Ungrouping (``group_id is None``) is always allowed.
        """
        if group_id is None:
            return None
        if group_id == entity.id:
            return "an entity cannot be its own parent"
        target = await Group.get_by_id(group_id)
        if target is None:
            return f"target group {group_id} does not exist"
        entity_project = getattr(entity, "project_id", None)
        if entity_project and target.project_id and entity_project != target.project_id:
            return "cannot move across projects"
        if isinstance(entity, Group):
            if entity.group_namespace and target.group_namespace and entity.group_namespace != target.group_namespace:
                return "cannot move a group across namespaces"
            if await Group._is_descendant(candidate=target, of_id=entity.id):
                return "cannot move a group under itself or its own descendant"
        return None

    @staticmethod
    async def _is_descendant(candidate: "Group", of_id: str) -> bool:
        """Walk ``candidate``'s parent chain; True when ``of_id`` appears."""
        current: Optional[Group] = candidate
        for _ in range(MAX_GROUP_DEPTH):
            if current is None:
                return False
            if current.id == of_id:
                return True
            if not current.group_id:
                return False
            current = await Group.get_by_id(current.group_id)
        # Depth exhausted — a pathological chain; treat as a cycle (reject).
        return True

    # ── HTTP actions (folder mechanics) ──────────────────────────────────────

    @action.post(action_name="move")
    async def _http_move(self) -> ApiResponse:
        """Re-parent this group (``{group_id: <id|null>}``), cycle-checked."""
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        group_id = body.get("group_id") if isinstance(body, dict) else None
        error = await Group.validate_membership(self, group_id)
        if error:
            return ApiFailResponse(message=error)
        self.group_id = group_id
        await self.save()
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="delete-group")
    async def _http_delete_group(self) -> ApiResponse:
        """Delete this group; its children move up to this group's parent.

        Children = subgroups AND member entities of every registered type
        (they all point here via ``group_id``). No destructive recursion in
        v1 — nothing but the group itself is deleted.
        """
        moved = 0
        for child in await self._children_of_any_type():
            child.group_id = self.group_id
            await child.save()
            moved += 1
        await self.delete()
        return ApiSuccessResponse(data={"deleted": self.id, "moved_children": moved})

    async def _children_of_any_type(self) -> list[Entity]:
        """Every entity whose ``group_id`` points here, across all types.

        One indexed per-type query per registered entity type (includes
        ``group`` itself, so subgroups ride the same sweep). Delete is rare;
        the loop is the correct no-orphans guarantee without inventing a new
        cross-type DB path.
        """
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        children: list[Entity] = []
        for type_name in SchemaRegistry.get_all_entity_types():
            cls = SchemaRegistry.get_entity_cls(type_name)
            if cls is None:
                continue
            try:
                rows = await cls.get_all(
                    entities_filter=QueryFilter(match=ExpressionNode(group_id=self.id))
                )
            except Exception:
                # Types without queryable storage simply don't participate.
                continue
            children.extend(rows or [])
        return children
