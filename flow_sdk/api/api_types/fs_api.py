import re

from pydantic import BaseModel, ConfigDict

from flow_sdk import service_log
from flow_sdk.api.api_types.identifier import type_uuid_pattern
from flow_sdk.api.api_types.type_id import TypeId
# TODO: request_context methods not available locally
def get_current_request_info():
    """Stub implementation of get_current_request_info"""
    return None
# TODO: request_info not available locally
class RequestInfo:
    """Stub implementation of RequestInfo"""
    def __init__(self):
        self.user = None
        self.action = None
        self.sub_path = None
        self.target_entity_typeid = None
# TODO: response types not available locally
class ApiFailResponse:
    """Stub implementation of ApiFailResponse"""
    def __init__(self, message: str = ""):
        self.message = message


class VFSPath:
    VFS_PATH_PROTOCOL = "vfs"

    def __init__(self, vfs_path: str | None = None) -> None:
        self._raw_path = vfs_path
        parsed = parse_custom_uri(vfs_path)
        self.protocol = parsed.get("protocol", None)
        if self.protocol and self.protocol != self.VFS_PATH_PROTOCOL:
            raise ValueError(f"Unsupported protocol: {self.protocol}")
        self.type = parsed.get("type", None)
        self.uuid = parsed.get("uuid", None)
        self.entity_sub_path = parsed.get("path", None)
        if self.entity_sub_path:
            self.entity_sub_path = self.entity_sub_path.lstrip("/")
        else:
            self.entity_sub_path = ""
        self.query = parsed.get("query", None)
        self.fragment = parsed.get("fragment", None)
        if vfs_path is not None and vfs_path.startswith("/") and not self.typeid:
            request_info = get_current_request_info()
            if not request_info:
                service_log.highlighted_error("Virtual path requires user in context")
                raise ValueError("Absolute path is invalid, No request info found")
            if not request_info.user:
                raise ValueError("Absolute path is invalid, No user found in request info")
            self.typeid = request_info.user.typeid

    def is_absolute(self) -> bool:
        return self.typeid is not None

    @staticmethod
    def from_entity_path(typeid: TypeId, entity_vfs_path="/") -> "VFSPath":
        return VFSPath(f"{typeid}/{entity_vfs_path.lstrip('/')}")

    @property
    def typeid(self) -> TypeId | None:
        if not self.type:
            return None
        if not self.uuid:
            return None
        return TypeId(type=self.type, id=self.uuid)

    @typeid.setter
    def typeid(self, value: TypeId):
        self.type = value.type
        self.uuid = value.id

    @property
    def entity_subpath(self) -> str:
        return f"{self.entity_sub_path}"

    @property
    def abs_vfspath(self):
        if not self.typeid:
            return ""
        if not self.entity_sub_path:
            typeid_uri = f"{self.typeid}/"
        else:
            typeid_uri = f"{self.typeid}/{self.entity_sub_path}"
        return typeid_uri

    @property
    def uri(self) -> str:
        return f"{VFSPath.VFS_PATH_PROTOCOL}://{self.abs_vfspath}"

    @property
    def filename(self) -> str:
        if not self.entity_sub_path:
            return ""
        return self.entity_sub_path.split("/")[-1]


protocol_pattern = re.compile(r"^(?P<protocol>[a-zA-Z][a-zA-Z0-9+.-]*)://")
path_pattern = re.compile(r"^(?P<path>/?[^?#]*)")
query_pattern = re.compile(r"^\?(?P<query>[^#]*)")
fragment_pattern = re.compile(r"^#(?P<fragment>.*)")


# noinspection PyUnresolvedReferences
def parse_custom_uri(uri):
    parsed: dict[str, str | None] = {
        "protocol": None,
        "type": None,
        "uuid": None,
        "path": None,
        "query": None,
        "fragment": None,
    }
    if not uri:
        return parsed
    # Check for protocol
    match = protocol_pattern.match(uri)
    if match:
        parsed["protocol"] = match.group("protocol")
        uri = uri[match.end() :]  # Remove the matched protocol part

    # Check for type and UUID
    type_uuid_matcher = re.compile(type_uuid_pattern)
    match = type_uuid_matcher.match(uri)
    if match:
        if len(match.groups()) != 2:
            msg = f"Invalid TypeId, expecting only two match groups: {uri}"
            service_log.highlighted_error(msg)
            raise ValueError(msg)
        parsed["type"] = match.group(1)
        parsed["uuid"] = match.group(2)
        uri = uri[match.end() :]  # Remove the matched type and UUID part

    # Check for path
    match = path_pattern.match(uri)
    if match:
        parsed["path"] = match.group("path")
        uri = uri[match.end() :]  # Remove the matched path part

    # Check for query
    match = query_pattern.match(uri)
    if match:
        parsed["query"] = match.group("query")
        uri = uri[match.end() :]  # Remove the matched query part

    # Check for fragment
    match = fragment_pattern.match(uri)
    if match:
        parsed["fragment"] = match.group("fragment")
        # uri = uri[match.end():]  # Remove the matched fragment part

    return parsed


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
        vfs_path: VFSPath = VFSPath()
        vfs_path.typeid = entity_tid
        vfs_path.entity_sub_path = entity_app_subpath
        return EntityFSReqInfo(fs_action=fs_action, vpath=vfs_path)

    def __str__(self):
        return f"FSSubtype: {self.__dict__}"

    @property
    def abs_path(self):
        return self.vpath.abs_vfspath


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
