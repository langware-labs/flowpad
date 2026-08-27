from pydantic import BaseModel, ConfigDict

from flow_sdk.api.api_types.vfs_path import VFSPath
from flow_sdk.request_context import get_current_request_info
from flow_sdk.request_context.request_info import RequestInfo
from flow_sdk.responses import ApiFailResponse


class EntityFSReqInfo(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    fs_action: str
    vpath: VFSPath

    @staticmethod
    def from_request_info(request_info: RequestInfo):
        subpath = request_info.sub_path
        if not subpath:
            raise RuntimeError("No subpath found in request info")
        sub_path_parts = subpath.split("/")
        fs_action = sub_path_parts[0]
        entity_app_subpath = "/".join(sub_path_parts[1:])
        entity_tid = request_info.target_entity_typeid
        if not entity_tid:
            if not request_info.user:
                raise RuntimeError("No user found in request info")
            entity_tid = request_info.user.typeid
        if not entity_app_subpath:
            entity_app_subpath = "/"
        vfs_path = VFSPath.from_entity_path(entity_tid, entity_app_subpath)
        return EntityFSReqInfo(fs_action=fs_action, vpath=vfs_path)

    def __str__(self):
        return f"FSSubtype: {self.__dict__}"

    @property
    def abs_path(self):
        return self.vpath.abs_path


def get_request_fs_info() -> EntityFSReqInfo:
    current_request_info = get_current_request_info()
    if not current_request_info:
        res = ApiFailResponse(message="No request info found")
        raise RuntimeError(res)
    if not current_request_info.action:
        res = ApiFailResponse(message="No action found in request info")
        raise RuntimeError(res)
    if current_request_info.action != "fs":
        res = ApiFailResponse(message="Action is not fs")
        raise RuntimeError(res)
    if not current_request_info.sub_path:
        res = ApiFailResponse(message="No subpath found in request info")
        raise RuntimeError(res)
    if not current_request_info.target_entity_typeid and not current_request_info.user:
        res = ApiFailResponse(message="No parent entity found in request info")
        raise RuntimeError(res)
    return EntityFSReqInfo.from_request_info(current_request_info)


allowed_fs_actions = [
    "browse",
    "upload",
    "download",
    "serve",
    "download_zip",
    "upload_zip",
    "delete",
    "rename",
    "copy",
    "move",
    "mkdir",
    "write",
    "open",
    "create_symlink",
    "resolve_symlink",
    "import_item",
]
