import logging
import os
import random
import string
import sys
from datetime import datetime, timezone
from typing import Any, ClassVar, List

from fastapi import HTTPException
from pydantic import ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from flow_sdk.config import AGENT_MOUNT_FOLDER, PLATFORM_WIN32, StorageProvider
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.flowpad_types.enums import AuthRole
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.worker_sessions import get_worker_sessions
from flow_sdk.core import Entity, QueryFilter, action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.core.flow.flow_source_control import ComputeSourceControlInitializeOptions
from flow_sdk.core.flow.mcp_server import MCPConnector, mcp_connector_pool
from flow_sdk.core.flow.models.execution.env_context import get_env_vars_context
from flow_sdk.request_context.methods import (
    get_current_request_info,
    get_current_service,
)
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _generate_session_code() -> str:
    """Generate a shareable XXXX-XXXX join code."""
    alphabet = string.ascii_uppercase + string.digits
    left = "".join(random.choices(alphabet, k=4))
    right = "".join(random.choices(alphabet, k=4))
    return f"{left}-{right}"


class ProjectInitializeOptions(ComputeSourceControlInitializeOptions):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True)

    mcp_connector_init: bool = Field(default=True)


class Project(Entity):
    type: str = APIField(default=BuiltinEntityType.PROJECT.value)
    name: str | None = APIField(default=None, description="Display name of the project")
    artifacts: List[str] = APIField(
        default_factory=list,
        description="List of artifact IDs belonging to this project",
    )
    fs_storage_provider: StorageProvider | None = StorageProvider.SANDBOX
    fs_storage_mount_path: str | None = APIField(
        default=None, description="Full path to the project folder"
    )
    # ── Collaboration overlay (merged from the former CollaborationSpace entity) ──
    session_code: str | None = APIField(
        default=None,
        description="Shareable join code for the project's collaboration space, e.g. ABCD-EFGH. Lazily generated.",
    )
    host_member_id: str | None = APIField(
        default=None,
        description="Stable local member_id of whoever first started collaboration on this project",
    )
    members: list[dict] = APIField(
        default_factory=list,
        description="Collaboration participants: [{member_id, name, joined_at, last_seen_at}]",
    )
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "FolderOpen"

    @model_validator(mode="after")
    def set_fs_storage_mount_path(self):
        """Set the storage mount path based on project name and create the folder if needed."""
        if self.name and not self.fs_storage_mount_path:
            if os.path.isabs(self.name):
                # Name is an absolute path - use it directly as mount path
                self.fs_storage_mount_path = self.name
                self.name = os.path.basename(self.name)
            elif "/" in self.name or "\\" in self.name:
                # Name is a VFS-relative path - convert to absolute OS path
                # VFS root maps to OS root ("/" on Unix, "C:\" on Windows)
                if sys.platform == PLATFORM_WIN32:
                    drive = os.path.splitdrive(AGENT_MOUNT_FOLDER)[0]
                    os_root = drive + os.sep
                else:
                    os_root = os.sep
                self.fs_storage_mount_path = os.path.normpath(
                    os.path.join(os_root, self.name)
                )
                self.name = os.path.basename(self.fs_storage_mount_path)
            else:
                # Simple name like "my_first_project"
                self.fs_storage_mount_path = os.path.join(AGENT_MOUNT_FOLDER, self.name)

        # Prevent project mount path from being the user's home directory.
        home_dir = os.path.expanduser("~").rstrip(os.sep)
        if (
            self.fs_storage_mount_path
            and self.fs_storage_mount_path.rstrip(os.sep) == home_dir
        ):
            self.fs_storage_mount_path = os.path.join(
                AGENT_MOUNT_FOLDER, self.name or "home"
            )

        # Create the project folder if it doesn't exist.
        if self.fs_storage_mount_path and not os.path.exists(
            self.fs_storage_mount_path
        ):
            try:
                os.makedirs(self.fs_storage_mount_path, exist_ok=True)
            except OSError as e:
                logging.warning(
                    f"Project: could not create mount path {self.fs_storage_mount_path!r}: {e}"
                )
        return self

    @classmethod
    def allocate_id(cls, data: dict) -> str:
        """Deterministic UUID5 keyed on the project work directory.

        The deterministic ID takes priority over any client-provided id, because
        the frontend always assigns a random UUID4 to new entities before saving.
        Only fall back to the provided id (or a fresh UUID4) when no mount path
        is available to derive a stable key from.
        """
        import uuid
        from flow_sdk.fs_store.identifier import is_valid_uuid
        mount_path = data.get("fs_storage_mount_path") or data.get("real_path")
        if not mount_path:
            name = data.get("name", "")
            if name and os.path.isabs(name):
                mount_path = name
        if mount_path:
            return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project:{mount_path}"))
        rid = data.get("id") or ""
        if rid and is_valid_uuid(rid):
            return rid
        return str(uuid.uuid4())

    @property
    def project_encoded_name(self) -> str | None:
        """Encoded project path used to locate transcript files."""
        if not self.fs_storage_mount_path:
            return None
        return str(self.fs_storage_mount_path).replace("/", "-")

    @property
    def main_ref(self):
        """FSRef pointing to the project working directory."""
        if not self.fs_storage_mount_path:
            return None
        from pathlib import Path
        from flow_sdk.fs_store.fs_ref import FSRef
        return FSRef(Path(self.fs_storage_mount_path))

    async def get_compute_node(self):
        from flow_sdk.config import default_service_config

        # In desktop/local mode, always use the @local compute node
        if default_service_config.is_local:
            return await ComputeNode.get_by_uname("local")

        project_compute_nodes = await ComputeNode.get_all(source_entity=self.typeid)
        if project_compute_nodes:
            if len(project_compute_nodes) > 1:
                logging.warning(
                    f"Multiple compute nodes found for project {self.typeid}"
                )
                project_compute_nodes = list(
                    sorted(
                        project_compute_nodes,
                        key=lambda x: x.created_date or 0,
                        reverse=True,
                    )
                )
            return project_compute_nodes[0]
        return None

    async def get_mcp_connector(self):
        project_compute_node = await self.get_compute_node()
        if project_compute_node:
            return MCPConnector(compute_node=project_compute_node)
        warm_mcp_connector = await mcp_connector_pool.get_warm_mcp_connector()
        # Ensure compute_node exists in DB before creating relationship
        # Note: The pool's compute_node might think it exists in DB (created_by set from previous save)
        # but the DB may have been reset. Force-check and save if needed.
        compute_node = warm_mcp_connector.compute_node
        db_compute_node = await ComputeNode.get_by_id(compute_node.id)
        if not db_compute_node:
            # Node doesn't actually exist in DB - clear created_by to force save
            compute_node.created_by = None
            await compute_node.save()
        await self.add_child(compute_node)
        return warm_mcp_connector

    @classmethod
    async def get_mcp_connector_for_process(cls, process_typeid: TypeId):
        compute_node = await ComputeNode.get_one(source_entity=process_typeid)
        if compute_node:
            return MCPConnector(compute_node=compute_node)

        project = await cls.get_ancestor(process_typeid)
        if not project:
            logging.warning(
                f"No project or compute node found for process {process_typeid}"
            )
            new_project = cls()
            await new_project.save()
            await new_project.attach_child(process_typeid)
            project = new_project
        return await project.get_mcp_connector()

    @classmethod
    async def get_mcp_connector_for_flow(cls, flow_typeid: TypeId):
        """Backward-compatible alias for get_mcp_connector_for_process."""
        return await cls.get_mcp_connector_for_process(flow_typeid)

    @action.post(action_name="initialize")
    async def initialize(
        self, initialize_options: ProjectInitializeOptions | None = None
    ):
        if not initialize_options:
            initialize_options = ProjectInitializeOptions()

        mcp_connector = await self.get_mcp_connector()
        if initialize_options.mcp_connector_init:
            process_env_list = await get_env_vars_context(
                get_current_request_info().user, self
            )
            async with mcp_connector.initialize(initialize_options, process_env_list):
                pass

        compute_node = await self.get_compute_node()
        return ApiSuccessResponse(
            data={"compute_node": compute_node.model_dump() if compute_node else None}
        )

    async def _get_process_by_source_impl(self, source_vfs_path: str):
        """Find an existing process entity associated with the given source file path."""
        from flow_sdk.builtin.process import Flow

        if not source_vfs_path:
            raise HTTPException(status_code=400, detail="source_vfs_path is required")

        # Query all child process entities of this project
        process_filter = QueryFilter.by_type(Flow.get_type())
        child_processes = await self.get_children(child_filter=process_filter)

        # Find the process with matching source_vfs_path
        for child in child_processes:
            process_entity = child.value
            if (
                isinstance(process_entity, Flow)
                and process_entity.source_vfs_path == source_vfs_path
            ):
                return ApiSuccessResponse(data=process_entity)

        # No process found with this source path
        return ApiSuccessResponse(data=None)

    @action.get(action_name="get-process-by-source")
    async def get_process_by_source(self, source_vfs_path: str):
        return await self._get_process_by_source_impl(source_vfs_path)

    @action.get(action_name="get-flow-by-source")
    async def get_flow_by_source(self, source_vfs_path: str):
        """Backward-compatible alias for get_process_by_source."""
        return await self._get_process_by_source_impl(source_vfs_path)

    @action.get(action_name="get-compute-node")
    async def get_compute_node_action(self):
        compute_node = await self.get_compute_node()
        return ApiSuccessResponse(
            data={"compute_node": compute_node.model_dump() if compute_node else None}
        )

    @action.get(action_name="get-worker-sessions")
    async def _get_worker_sessions_action(self):
        """Get worker sessions for current directory."""
        sessions = get_worker_sessions()
        return ApiSuccessResponse(data=sessions)

    @action.post(action_name="setup-for-desktop")
    async def setup_for_desktop(self):
        """Connect project to desktop entities (workspace, agent, compute node).

        This action links the project to the @local workspace, @local agent, and @local compute node
        that were created during desktop bootstrap. Should be called after creating/opening a project
        in desktop mode.

        Returns:
            ApiSuccessResponse with workspace, agent, and compute_node entities
        """
        from flow_sdk.builtin.workspace import Workspace

        # Get the @local workspace
        local_workspace = await Workspace.get_by_uname("local")
        if local_workspace:
            # Add project as child of workspace
            await local_workspace.attach_child(self.typeid)
            logging.info(
                f"Connected project {self.id} to @local workspace {local_workspace.id}"
            )

        # Get the @local compute node
        local_compute_node = await ComputeNode.get_by_uname("local")
        if local_compute_node:
            # Add compute node as child of project
            await self.attach_child(local_compute_node.typeid)
            logging.info(
                f"Connected @local compute node {local_compute_node.id} to project {self.id}"
            )

        return ApiSuccessResponse(
            data={
                "workspace": local_workspace.model_dump() if local_workspace else None,
                "agent": None,
                "compute_node": local_compute_node.model_dump()
                if local_compute_node
                else None,
            }
        )

    # ── Collaboration helpers (merged from CollaborationSpace) ──────────────

    async def _upsert_member(self, member_id: str, name: str) -> dict:
        now = _now_iso()
        members = list(self.members or [])
        for m in members:
            if m.get("member_id") == member_id:
                m["name"] = name
                m["last_seen_at"] = now
                if not m.get("joined_at"):
                    m["joined_at"] = now
                self.members = members
                await self.save()
                return m
        entry = {
            "member_id": member_id,
            "name": name,
            "joined_at": now,
            "last_seen_at": now,
        }
        members.append(entry)
        self.members = members
        await self.save()
        return entry

    async def _touch_member(self, member_id: str) -> bool:
        members = list(self.members or [])
        now = _now_iso()
        for m in members:
            if m.get("member_id") == member_id:
                m["last_seen_at"] = now
                self.members = members
                await self.save()
                return True
        return False

    @classmethod
    async def get_by_session_code(cls, code: str) -> "Project | None":
        """Find a Project whose session_code matches (case-insensitive)."""
        normalized = (code or "").upper().strip()
        if not normalized:
            return None
        all_projects = await cls.get_all()
        for proj in all_projects:
            if (proj.session_code or "").upper() == normalized:
                return proj
        return None

    @action.post(action_name="ensure-collaboration-code")
    async def _http_ensure_collaboration_code(self) -> ApiResponse:
        """Ensure this project has a session_code + host. Idempotent."""
        request_info = get_current_request_info()
        body: dict[str, Any] = await request_info.get_post_data() if request_info else {}
        host_name = body.get("host_name")
        host_member_id = body.get("host_member_id")
        changed = False
        if not self.session_code:
            self.session_code = _generate_session_code()
            changed = True
        if host_member_id and not self.host_member_id:
            self.host_member_id = host_member_id
            changed = True
        if changed:
            await self.save()
        # Seed the host as the first member on first call.
        if host_name and host_member_id:
            existing = next(
                (m for m in (self.members or []) if m.get("member_id") == host_member_id),
                None,
            )
            if existing is None:
                await self._upsert_member(host_member_id, host_name)
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="join-collaboration")
    async def _http_join_collaboration(self) -> ApiResponse:
        """POST body: {member_id, name} → add the caller to project.members."""
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        member_id = body.get("member_id")
        name = body.get("name")
        if not member_id or not name:
            return ApiFailResponse(message="member_id and name are required")
        await self._upsert_member(member_id=member_id, name=name)
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="heartbeat-collaboration")
    async def _http_heartbeat_collaboration(self) -> ApiResponse:
        """POST body: {member_id} → bump last_seen_at for that member."""
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        member_id = body.get("member_id")
        if not member_id:
            return ApiFailResponse(message="member_id is required")
        updated = await self._touch_member(member_id)
        return ApiSuccessResponse(data={"ok": updated, "members": self.members})
