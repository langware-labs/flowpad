import logging
import os
import sys
from typing import ClassVar, List

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
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse


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

    async def _create_process_impl(
        self,
        process_id: str = "",
        agent_id: str | None = None,
        source_vfs_path: str | None = None,
    ):
        return ApiFailResponse(
            message="_create_process_impl is a cloud-only path and is not supported in the desktop environment."
        )

    @action.post(action_name="create-process")
    async def create_process(
        self,
        process_id: str = "",
        agent_id: str | None = None,
        source_vfs_path: str | None = None,
    ):
        return await self._create_process_impl(
            process_id=process_id,
            agent_id=agent_id,
            source_vfs_path=source_vfs_path,
        )

    @action.post(action_name="create-flow")
    async def create_flow(
        self,
        flow_id: str = "",
        agent_id: str | None = None,
        source_vfs_path: str | None = None,
    ):
        """Backward-compatible alias for create_process."""
        return await self._create_process_impl(
            process_id=flow_id,
            agent_id=agent_id,
            source_vfs_path=source_vfs_path,
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
