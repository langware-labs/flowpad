"""flow_sdk.server — reusable server components for SDK-based FastAPI apps.

Public API::

    from flow_sdk.server import (
        FlowServer,
        FlowDrivers,
        CatchAllExceptionMiddleware,
        RequestTransactionMiddleware,
        graph_router,
        health_router,
        bootstrap_router,
        init_sod_driver,
        init_local_storage_driver,
    )

Heavy symbols (middleware, routers, startup helpers) are lazy-loaded via
``__getattr__`` to avoid circular imports when only ``FlowServer`` /
``FlowDrivers`` are needed.
"""

from .driver_types import FlowDrivers
from .flow_server import FlowServer

__all__ = [
    "FlowServer",
    "FlowDrivers",
    "CatchAllExceptionMiddleware",
    "RequestTransactionMiddleware",
    "graph_router",
    "health_router",
    "bootstrap_router",
    "init_sod_driver",
    "init_local_storage_driver",
]

# Lazy imports for symbols that pull in heavy dependency chains.
_LAZY_MAP: dict[str, tuple[str, str]] = {
    "CatchAllExceptionMiddleware": (
        ".middleware.catch_all_exception_middleware",
        "CatchAllExceptionMiddleware",
    ),
    "RequestTransactionMiddleware": (
        ".middleware.request_transaction_middleware",
        "RequestTransactionMiddleware",
    ),
    "graph_router": (".routes", "graph_router"),
    "health_router": (".routes", "health_router"),
    "bootstrap_router": (".routes", "bootstrap_router"),
    "init_sod_driver": (".startup", "init_sod_driver"),
    "init_local_storage_driver": (".startup", "init_local_storage_driver"),
}


def __getattr__(name: str):
    if name in _LAZY_MAP:
        module_path, attr = _LAZY_MAP[name]
        import importlib

        mod = importlib.import_module(module_path, __name__)
        value = getattr(mod, attr)
        # Cache on the module so __getattr__ is not called again
        globals()[name] = value
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
