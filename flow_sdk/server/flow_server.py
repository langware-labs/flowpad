"""FlowServer — builder for SDK-based FastAPI applications.

Usage::

    from flow_sdk.server import FlowServer, FlowDrivers

    server = FlowServer()
    server.load_driver(FlowDrivers.DB, MyDBDriver)
    server.add_router(my_router)
    server.on_startup(my_init)
    server.on_shutdown(my_cleanup)
    app = server.create()
"""

from __future__ import annotations

import inspect
from contextlib import asynccontextmanager
from typing import Any, Callable

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .driver_types import FlowDrivers


class FlowServer:
    """Builder that assembles a FastAPI app from SDK components."""

    def __init__(self) -> None:
        self._drivers: dict[FlowDrivers, Any] = {}
        self._routers: list[tuple[APIRouter, dict]] = []
        self._startup_hooks: list[Callable] = []
        self._shutdown_hooks: list[Callable] = []
        self._cors_config: dict = {
            "allow_origins": ["null"],  # "null" origin for srcdoc/sandboxed iframes
            "allow_origin_regex": r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
            "allow_credentials": True,
            "allow_methods": ["*"],
            "allow_headers": ["*"],
        }

    # ── Phase 1: Setup ───────────────────────────────────────────────────

    def load_driver(self, driver_type: FlowDrivers, driver: Any) -> FlowServer:
        """Register a driver (class or instance)."""
        self._drivers[driver_type] = driver
        return self

    def add_router(self, router: APIRouter, **kwargs: Any) -> FlowServer:
        """Add an app-specific router. *kwargs* are forwarded to ``include_router``."""
        self._routers.append((router, kwargs))
        return self

    def on_startup(self, hook: Callable) -> FlowServer:
        """Register an async callable to run after core startup."""
        self._startup_hooks.append(hook)
        return self

    def on_shutdown(self, hook: Callable) -> FlowServer:
        """Register an async callable to run before core shutdown."""
        self._shutdown_hooks.append(hook)
        return self

    # ── Phase 2: Create ──────────────────────────────────────────────────

    def create(self) -> FastAPI:
        """Build and return the configured FastAPI application."""
        # 1. Register DB driver (must happen before entity imports)
        self._setup_db_driver()

        # 2. Load entities and actions
        from flow_sdk.core.loaders import load_actions, load_entities

        load_entities()
        load_actions()

        # 3. Create FastAPI with lifespan
        app = FastAPI(lifespan=self._build_lifespan())

        # 4. Middleware (added in reverse execution order)
        from .middleware.catch_all_exception_middleware import CatchAllExceptionMiddleware
        from .middleware.request_transaction_middleware import RequestTransactionMiddleware

        app.add_middleware(CatchAllExceptionMiddleware)
        app.add_middleware(RequestTransactionMiddleware)
        app.add_middleware(CORSMiddleware, **self._cors_config)

        # 5. Core routers
        from .routes import bootstrap_router, health_router, wiki_router

        app.include_router(bootstrap_router)
        app.include_router(health_router, prefix="/api/v1/health")
        app.include_router(health_router, prefix="/health")
        app.include_router(wiki_router)

        # 6. User routers (in order added)
        for router, kwargs in self._routers:
            app.include_router(router, **kwargs)

        # 7. Graph router last (catch-all)
        from .routes import graph_router

        app.include_router(graph_router, prefix="/api/v1/graph")

        return app

    # ── Internals ────────────────────────────────────────────────────────

    def _setup_db_driver(self) -> None:
        """Register the DB driver in the global driver registry."""
        db = self._drivers.get(FlowDrivers.DB)
        if db is None:
            return  # keep default (sqlite)

        from flow_sdk.db.drivers.db_driver import _driver_instances, set_default_driver

        # If a class was passed, instantiate it
        if inspect.isclass(db):
            db = db()

        # Infer driver name from class name (Neo4JDBDriver → "neo4j", etc.)
        name = getattr(db, "driver_name", None)
        if name is None:
            cls_name = type(db).__name__.lower()
            for known in ("neo4j", "sqlite", "networkx"):
                if known in cls_name:
                    name = known
                    break
            else:
                name = cls_name.removesuffix("dbdriver").removesuffix("driver") or "custom"

        _driver_instances[name] = db
        set_default_driver(name)

    def _build_lifespan(self) -> Callable:
        """Return an async context manager for FastAPI lifespan."""
        drivers = self._drivers
        startup_hooks = self._startup_hooks
        shutdown_hooks = self._shutdown_hooks

        @asynccontextmanager
        async def lifespan(_app: FastAPI):
            from flow_sdk.db.database import close_db, init_db

            # ── Startup ──────────────────────────────────────────────
            await init_db()

            # SOD driver
            sod = drivers.get(FlowDrivers.SOD)
            if sod is not None:
                from flow_sdk.request_context.methods import set_default_test_sod_driver
                set_default_test_sod_driver(sod)
            else:
                from .startup import init_sod_driver
                init_sod_driver()

            # Storage driver
            storage = drivers.get(FlowDrivers.STORAGE)
            if storage is not None:
                from flow_sdk.request_context.methods import set_default_test_storage_fallback
                set_default_test_storage_fallback(storage)
            else:
                from .startup import init_local_storage_driver
                init_local_storage_driver()

            # User startup hooks
            for hook in startup_hooks:
                await hook()

            yield

            # ── Shutdown ─────────────────────────────────────────────
            for hook in shutdown_hooks:
                await hook()

            await close_db()

        return lifespan
