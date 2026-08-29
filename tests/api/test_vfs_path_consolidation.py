"""Contracts for the single, context-free VFSPath implementation."""

from flow_sdk.api.api_types.fs_api import VFSPath as ApiTypesVFSPath
from flow_sdk.api.api_types.vfs_path import VFSPath as CanonicalVFSPath
from flow_sdk.api.fs.fs_api import EntityFSReqInfo
from flow_sdk.api.fs.fs_api import VFSPath as FsPackageVFSPath
from flow_sdk.api.fs_api import VFSPath as LegacyVFSPath
from flow_sdk.api.type_id import TypeId
from flow_sdk.request_context.request_info import RequestInfo


def test_all_public_imports_are_the_same_vfs_path_class():
    assert CanonicalVFSPath is FsPackageVFSPath
    assert CanonicalVFSPath is LegacyVFSPath
    assert CanonicalVFSPath is ApiTypesVFSPath


def test_machine_absolute_path_parsing_is_pure_and_untyped():
    path = CanonicalVFSPath("/Users/shlom/Documents/interface.md")

    assert path.typeid is None
    assert path.entity_sub_path == "Users/shlom/Documents/interface.md"
    assert path.abs_path == "Users/shlom/Documents/interface.md"


def test_named_local_locator_has_canonical_uri_and_abs_path():
    path = CanonicalVFSPath("vfs://compute_node-@local/Users/shlom/interface.md")

    assert path.abs_path == "compute_node-@local/Users/shlom/interface.md"
    assert path.abs_vfspath == path.abs_path
    assert path.uri == "vfs://compute_node-@local/Users/shlom/interface.md"


def test_request_adapter_explicitly_qualifies_the_request_subpath():
    request_info = RequestInfo()
    request_info.sub_path = "browse/Users/shlom/Documents/interface.md"
    request_info.target_entity_typeid = TypeId(type="compute_node", id="@local")

    fs_info = EntityFSReqInfo.from_request_info(request_info)

    assert fs_info.fs_action == "browse"
    assert fs_info.vpath.uri == "vfs://compute_node-@local/Users/shlom/Documents/interface.md"
