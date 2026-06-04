from __future__ import annotations

from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

from starlette.requests import Request

# TODO: ServiceConfig - stub import
class ServiceConfig:
    """Stub ServiceConfig class for type hints"""
    development: bool = True
    sandbox_storage_mount_path: str = "/tmp"

from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.execution_context import get_execution_context

# Note: These are flow-cli paths, not FlowPad
from flow_sdk.config import default_service_config
from flow_sdk.api.api_types.type_id import TypeId

if TYPE_CHECKING:
    from fastapi import FastAPI

    # TYPE_CHECKING imports - stubs for type hints only
    class StorageDriver:
        """Stub StorageDriver for type hints"""
        pass

    class FlowpadService:
        """Stub FlowpadService for type hints"""
        pass

    class SodDriver:
        """Stub SodDriver for type hints"""
        pass


def get_current_request() -> Request | None:
    execution_context = get_execution_context()
    if execution_context is None:
        return None
    if execution_context.request_info is None:
        return None
    if execution_context.request_info.request is None:
        return None
    return execution_context.request_info.request


def get_current_app() -> FastAPI | None:
    request = get_current_request()
    if request is None:
        return None
    return request.app


_current_running_service: FlowpadService | None = None


def get_current_service() -> FlowpadService | None:
    global _current_running_service
    if _current_running_service is not None:
        return _current_running_service
    app = get_current_app()
    if app is not None:
        service = getattr(app.state, "service", None)
        if service is not None:
            return service
    execution_context = get_execution_context()
    if execution_context is not None:
        return getattr(execution_context, "service", None)
    return None


def set_current_service(service: FlowpadService):
    global _current_running_service
    _current_running_service = service


def get_default_storage_mount():
    service: FlowpadService | None = get_current_service()
    if service is None:
        return None
    return service.default_storage_mount


def get_default_storage():
    service: FlowpadService | None = get_current_service()
    if service is None:
        return None
    return service.default_storage_driver


test_storage_fallback: StorageDriver | None = None


def set_default_test_storage_fallback(storage_driver: StorageDriver | None):
    global test_storage_fallback
    test_storage_fallback = storage_driver


def get_embedded_storage(parent_storage: StorageDriver | None = None):
    if parent_storage is None:
        parent_storage = get_default_storage()
    if parent_storage is None:
        if test_storage_fallback:
            if not default_service_config.development:
                raise Exception("get_embedded_storage: Storage fallback allowed only development mode")
            parent_storage = test_storage_fallback
        else:
            raise Exception("get_embedded_storage: No parent_storage")
    return parent_storage.subfolder_storage("embedded")


def get_entity_embedded_storage(typeid: TypeId, parent_storage: StorageDriver | None = None):
    if parent_storage is None:
        parent_storage = get_embedded_storage()
    entity_storage = parent_storage.subfolder_storage(typeid.vfs_subfolder)
    entity_storage.root_entity_typeid = typeid
    return entity_storage


def get_entity_storage(typeid: TypeId, parent_storage: StorageDriver | None = None, entity: Any = None):
    """
    Get the FS storage driver for an entity.

    Resolution order:
    1. Entity fs_storage_provider field (if set)
    2. Embedded storage (default fallback)

    Args:
        typeid: The entity's TypeId
        parent_storage: Optional parent storage driver
        entity: Optional entity instance for property-based storage resolution
    """
    from flow_sdk.core.fs.drivers.storage_mount import StorageMount
    from flow_sdk.core.fs.flow_fs import get_storage_driver

    # Check entity for storage provider field
    if entity is not None:
        storage_provider = getattr(entity, "fs_storage_provider", None)
        if storage_provider is not None:
            config = get_current_service_config()
            mount_path = getattr(entity, "fs_storage_mount_path", None) or config.sandbox_storage_mount_path
            mount = StorageMount(
                name=f"{typeid.type}_storage",
                provider=storage_provider,
                storage_path=mount_path,
            )
            driver = get_storage_driver(mount)
            driver.root_entity_typeid = typeid
            return driver

    # Fall back to embedded storage
    return get_entity_embedded_storage(typeid, parent_storage)


test_sod_override = None


def set_default_test_sod_driver(sod_driver: SodDriver):
    global test_sod_override
    test_sod_override = sod_driver


def get_current_sod_store():
    """Resolve the active SOD store.

    Order:
      1. ``service.sod_driver`` — cloud/hub runtime (GCP/file SOD). Unchanged.
      2. ``test_sod_override`` — explicit test/embedding hook.
      3. ``get_instance_settings().sod`` — the single per-instance desktop
         store (keychain/env Fernet key over ``<inst>/sodot``). Always
         available; the key resolves lazily on first real secret access.
    """
    global test_sod_override
    service: FlowpadService | None = get_current_service()
    if service is not None and service.sod_driver is not None:
        return service.sod_driver
    if test_sod_override is not None:
        return test_sod_override
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    return get_instance_settings().sod


def get_current_email_provider():
    service: FlowpadService | None = get_current_service()
    if service is None:
        return None
    return service.email_provider


def get_current_request_info():
    execution_context = get_execution_context()
    if execution_context is None:
        return None
    return execution_context.request_info


def get_current_transaction_handler():
    request_info = get_current_request_info()
    if request_info is None:
        return None
    return request_info.transaction_handler


def get_current_transaction():
    transaction_handler = get_current_transaction_handler()
    if transaction_handler is None:
        return None
    return transaction_handler.db_transaction


default_config_context_var: ContextVar[ServiceConfig] = ContextVar("default_config_context_var")


def set_default_service_config(config: ServiceConfig) -> ServiceConfig:
    default_config_context_var.set(config)
    return config


def get_current_service_config() -> ServiceConfig:
    # noinspection PyBroadException
    try:
        service = get_current_service()
        if service is not None:
            return service.config
    except Exception:
        pass

    return default_service_config


def get_current_auth_scopes():
    request_info = get_current_request_info()
    if request_info is None or request_info.auth_result is None:
        return []
    return request_info.auth_result.target_auth_scopes


def get_current_workspace_typeid() -> TypeId | None:
    # Returns the first present workspace in the auth scopes
    auth_scopes = get_current_auth_scopes()
    if not auth_scopes:
        return None
    for scope in auth_scopes:
        for typeid in scope:
            if typeid.type == BuiltinEntityType.WORKSPACE.value:
                return typeid
    return None


def get_current_request_user():
    request_info = get_current_request_info()
    if request_info is None:
        raise Exception("get_current_request_user: No request_info")
    return request_info.user


def get_current_auth_result():
    request_info = get_current_request_info()
    if request_info is None:
        raise Exception("get_current_auth_result: No request info")
    return request_info.auth_result


def get_current_target_entity():
    auth_result = get_current_auth_result()
    if auth_result is None:
        raise Exception("get_current_target_entity: No auth result")
    return auth_result.target


def _sod_key(entity: Any, name: str) -> str:
    return f"{entity.type}_{name}_{entity.id}"


async def get_user_credentials(user, name: str, foreign_key: str | None = None) -> Any:
    sod_store: SodDriver = get_current_sod_store()
    value = await sod_store.read_user_sod(_sod_key(user, name), foreign_key)
    return value


async def set_user_credentials(user, name: str, value: Any, foreign_key: str):
    sod_store: SodDriver = get_current_sod_store()
    return await sod_store.write_user_sod(_sod_key(user, name), value, foreign_key)


async def delete_user_credentials(user, name: str, foreign_key: str | None = None):
    """Delete user credentials from SOD storage.

    ``foreign_key`` mirrors set/get so callers can target the exact composed key.
    """
    sod_store: SodDriver = get_current_sod_store()
    return await sod_store.delete_user_sod(_sod_key(user, name), foreign_key)


async def get_entity_credentials(entity, name: str) -> Any:
    sod_store: SodDriver = get_current_sod_store()
    value = await sod_store.read_sod(_sod_key(entity, name))
    return value


async def set_entity_credentials(entity, name: str, value) -> None:
    sod_store: SodDriver = get_current_sod_store()
    return await sod_store.write_sod(_sod_key(entity, name), value)


async def delete_entity_credentials(entity, name: str) -> None:
    """Delete entity credentials from SOD storage."""
    sod_store: SodDriver = get_current_sod_store()
    return await sod_store.delete_sod(_sod_key(entity, name))
