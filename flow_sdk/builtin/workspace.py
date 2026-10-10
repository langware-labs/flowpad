import logging
import types
from pathlib import Path
from typing import Optional

from pydantic import model_validator

from flow_sdk.api.api_types.api_field import APIField, NoDBAPIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.core.entity.entity_model import EntityType
from flow_sdk.db.db_entity import DBEntity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.request_context.methods import get_current_request_info

#: The default workspace's uname — the ``@local`` row bootstrap mints. Its root is
#: the instance's ``workspace_root``, resolved per call and never stored.
DEFAULT_WORKSPACE_UNAME = "local"
#: What the default workspace is called wherever it is shown.
DEFAULT_WORKSPACE_NAME = "Flowpad"


class WorkspaceRootError(ValueError):
    """A workspace's folder was refused: it would overlap a workspace, sit inside a
    project, or claim a protected path. A ``ValueError``, so the create route turns it
    into a 400 with this message."""


class Workspace(Entity):
    """A folder of related projects.

    A project belongs to the workspace whose ``root_path`` contains its folder; every
    project outside every user-created root belongs to the DEFAULT workspace (the
    ``@local`` row, whose root is ``agent_workspace_root()``). Membership is a location
    fact — there is no edge to keep in sync, and an instance with no user-created
    workspace behaves exactly as before workspaces existed.
    """

    type: str = APIField(default=BuiltinEntityType.WORKSPACE.value)
    name: str = APIField()
    # Where this workspace's projects live. ``None`` on the default workspace (its root
    # is resolved, so a moved instance never strands it) and filled with
    # ``<workspaces_home>/<name>`` on a create that names no folder. Local placement:
    # never leaves this machine.
    root_path: Optional[str] = APIField(
        default=None, description="Folder holding this workspace's projects", sharing=Sharing.PRIVATE
    )
    # Read-only views for the UI, recomputed on every load: the folder in the same
    # VFS-relative form as bootstrap's ``paths.workspace`` (which it equals on the
    # default workspace), and whether this is the default workspace.
    root: str = NoDBAPIField(default="", sharing=Sharing.PRIVATE)
    is_default: bool = NoDBAPIField(default=False, sharing=Sharing.PRIVATE)

    @model_validator(mode="after")
    def _canonical_root(self):
        if self.root_path:
            from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415

            self.root_path = canonical_posix_path(Path(self.root_path).expanduser())
        self._refresh_views()
        return self

    def _refresh_views(self) -> None:
        from flow_sdk.fs_store.path_utils import vfs_relative_path  # noqa: PLC0415

        self.is_default = self._is_default_row
        try:
            self.root = vfs_relative_path(str(self.folder))
        except Exception:
            self.root = ""

    @property
    def _is_default_row(self) -> bool:
        # The stored fact, not the ``is_default`` view: the view is assignable from a payload.
        return self.uname == DEFAULT_WORKSPACE_UNAME

    @property
    def folder(self) -> Path:
        """This workspace's folder — the instance's workspace root for the default one."""
        from flow_sdk.config import agent_workspace_root  # noqa: PLC0415

        if self._is_default_row or not self.root_path:
            return agent_workspace_root()
        return Path(self.root_path)

    @property
    def display_name(self) -> str:
        return DEFAULT_WORKSPACE_NAME if self._is_default_row else self.name

    async def save(self: EntityType, owner: DBEntity | TypeId | types.NoneType = None, notify: bool = True) -> EntityType:
        if not self._is_default_row:
            await self._settle_root()
        self._refresh_views()
        save_result = await super().save(owner, notify=notify)
        # TODO consider moving this to a separate action from client side
        await self.grant_access_to_public_data()
        await type(self)._roots_changed()
        return save_result

    async def delete(self):
        """Forget the workspace — never its folder. Its projects fall back to the default
        workspace by the location rule, and stay on disk untouched."""
        if self._is_default_row:
            raise WorkspaceRootError("the default workspace cannot be deleted")
        result = await super().delete()
        await type(self)._roots_changed()
        return result

    @classmethod
    async def delete_by_id(cls, eid: str):
        workspace = await cls.get_by_id(eid)
        return await workspace.delete() if workspace is not None else False

    async def _settle_root(self) -> None:
        """Fill the default folder, refuse a bad one, and create it.

        The root is fixed once saved: moving it would silently re-home every project
        under the old folder, so a rename changes the name only.
        """
        from flow_sdk.config import extra_workspace_roots  # noqa: PLC0415
        from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        if self.exist_in_db:
            # The registry holds every saved row's canonical root — no read needed.
            stored = extra_workspace_roots().get(str(self.id))
            if stored and stored != self.root_path:
                raise WorkspaceRootError("a workspace's folder cannot be changed after it is created")
            return
        if not (self.name or "").strip():
            raise WorkspaceRootError("a workspace needs a name")
        if not self.root_path:
            self.root_path = canonical_posix_path(get_instance_settings().workspaces_home / self.name.strip())
        await self._refuse_bad_root(self.root_path)
        Path(self.root_path).mkdir(parents=True, exist_ok=True)

    async def _refuse_bad_root(self, root: str) -> None:
        from flow_sdk.config import agent_workspace_root, extra_workspace_roots  # noqa: PLC0415
        from flow_sdk.fs_store.path_utils import canonical_posix_path, is_path_under, is_protected_path  # noqa: PLC0415

        if is_protected_path(root):
            raise WorkspaceRootError(f"{root} is a protected folder and cannot be a workspace")
        others = [canonical_posix_path(agent_workspace_root())]
        others += [r for wid, r in extra_workspace_roots().items() if wid != str(self.id)]
        for other in others:
            if is_path_under(root, other) or is_path_under(other, root):
                raise WorkspaceRootError(f"{root} overlaps the workspace at {other}")
        # Projects do not nest, and a workspace is not a project: its folder may HOLD
        # projects (they join it), but may not be one or sit inside one.
        from flow_sdk.fs_store.operations.all_projects import get_cached_projects  # noqa: PLC0415 — cycle

        for project in await get_cached_projects():
            mount = project.fs_storage_mount_path
            if mount and is_path_under(root, mount):
                raise WorkspaceRootError(f"{root} is inside the project {project.name!r} ({mount})")

    @classmethod
    async def _roots_changed(cls) -> None:
        """A workspace was saved or deleted: reload the roots, and refresh the bootstrap,
        which lists the workspaces by name (so a rename counts too)."""
        from flow_sdk.server.routes.bootstrap import invalidate_bootstrap_cache  # noqa: PLC0415

        await cls.load_roots()
        invalidate_bootstrap_cache()

    @classmethod
    async def load_roots(cls) -> None:
        """Refresh the in-memory root registry (``flow_sdk.config``) from the rows.

        The project caches depend on the roots, so they are dropped only when the roots
        changed (a rename changes none). A read, not a change: the bootstrap calls it
        while it builds, and must not have its own caches dropped under it.
        """
        from flow_sdk.config import set_workspace_roots  # noqa: PLC0415

        try:
            rows = await cls._user_created()
            default = await cls.default()
        except Exception:
            logging.exception("[workspace] could not load workspace roots")
            return
        roots = {str(w.id): w.root_path for w in rows}
        if set_workspace_roots(roots, default_id=str(default.id) if default else None):
            from flow_sdk.builtin.faas.project_list import invalidate_project_list_cache  # noqa: PLC0415
            from flow_sdk.fs_store.operations.all_projects import invalidate_projects_cache  # noqa: PLC0415

            invalidate_projects_cache()
            invalidate_project_list_cache()

    @classmethod
    async def _user_created(cls) -> list["Workspace"]:
        """The rows that own a folder — every workspace but the default one."""
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

        return await cls.get_all(QueryFilter(match=ExpressionNode(op=QueryOp.IS_NOT_NULL, operands=["root_path"])))

    # -- Python SDK surface -------------------------------------------------

    @classmethod
    async def new(cls, name: str, root_path: str | Path | None = None) -> "Workspace":
        """Create a workspace (``create`` is the base entity's own verb). With no ``root_path`` its folder is ``<workspaces_home>/<name>``."""
        workspace = cls(name=name, root_path=str(root_path) if root_path else None)
        return await workspace.save()

    @classmethod
    async def all_workspaces(cls, default: Optional["Workspace"] = None) -> list["Workspace"]:
        """Every workspace on this instance — the default one first. Pass ``default``
        when it is already in hand to skip its lookup."""
        default = default or await cls.default()
        rows = sorted(await cls._user_created(), key=lambda w: (w.name or "").casefold())
        return ([default] if default else []) + rows

    @classmethod
    async def default(cls) -> Optional["Workspace"]:
        return await cls.get_by_uname(DEFAULT_WORKSPACE_UNAME)

    @classmethod
    async def for_path(cls, path: str | Path) -> Optional["Workspace"]:
        """The workspace a folder belongs to (the default one when outside every root)."""
        from flow_sdk.config import workspace_id_for_path  # noqa: PLC0415

        workspace_id = workspace_id_for_path(path)
        if workspace_id is None:
            return await cls.default()
        return await cls.get_by_id(workspace_id)

    def contains(self, path: str | Path | None) -> bool:
        """True when ``path`` belongs to this workspace (the location rule)."""
        from flow_sdk.config import path_in_workspace  # noqa: PLC0415

        return path_in_workspace(path, str(self.id))

    async def projects(self) -> list:
        """This workspace's projects, by the location rule."""
        from flow_sdk.fs_store.operations.all_projects import get_cached_projects  # noqa: PLC0415 — cycle

        return [p for p in await get_cached_projects() if self.contains(p.fs_storage_mount_path)]

    @classmethod
    async def get_workspace_from_target_entity(cls):
        request_info = get_current_request_info()
        if not request_info:
            raise Exception("Invalid request_info.")
        target_entity_typeid = request_info.target_entity_typeid
        if not target_entity_typeid:
            raise Exception("Invalid target_entity - expected a workspace.", target_entity_typeid)
        if target_entity_typeid.type != cls.get_type() or not target_entity_typeid.id:
            raise Exception("Invalid target_entity - expected a workspace.", target_entity_typeid)
        workspace = await request_info.get_target_entity()
        if not workspace:
            raise Exception("Invalid target_entity - workspace doesn't exist.", target_entity_typeid.id)
        return workspace
