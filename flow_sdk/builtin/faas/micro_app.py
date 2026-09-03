"""MicroApp — the *delivery* plane of an app.

Three planes describe one app, each an entity that can exist without the others:

    Artifact (kind: application.web)   source   — what it is, where the code lives
      ├── Deployment  (artifact_id)    runtime  — a dev server on a port
      └── MicroApp    (artifact_id)    delivery — built output served over HTTP

``Deployment.artifact_id`` established this companion shape; MicroApp is the same
pattern for the half Deployment deliberately does not cover. A MicroApp with an
``artifact_id`` is an app's built output; one without is a standalone folder or
builtin bundle (how the console itself is served in cloud), which is why the FK
is optional rather than required.
"""

import logging as service_log
import os
from pathlib import Path
from typing import ClassVar, List, Optional

from fastapi import HTTPException
from pydantic import field_validator
from starlette.requests import Request
from starlette.responses import Response

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_request import APIRequest
from flow_sdk.api.api_types.api_field import APIField, EntityField, NoDbBField, Sharing
from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.builtin.faas.codebase import AppCodebase
from flow_sdk.builtin.faas.serve_static import ASSET_CACHE_CONTROL, AppNotBuilt, serve_app_bytes
from flow_sdk.config import default_service_config
from flow_sdk.core import Entity, action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.utils import ROOT_FOLDER
from flow_sdk.worldview.ontology import KindStr


class AppLocationType(StrEnum):
    Folder = "Folder"
    Builtin = "Builtin"
    GCPBucket = "GCPBucket"
    # Built output of an Artifact. ``location_root`` still carries the concrete
    # absolute directory (resolved once, at registration) so serving stays a
    # synchronous path join — resolving a GitOrigin per request would put a
    # checkout lookup in front of every asset fetch.
    Artifact = "Artifact"
    # A webapp REPO ASSET on disk: ``asset_ref`` is the app folder, ``build``
    # names the served subdir inside it. We start the app folder, we serve the
    # build — so the row needs both, and neither is ``location_root``.
    Asset = "Asset"


def get_micro_apps_root() -> Path:
    return Path(ROOT_FOLDER) / "micro_apps"


def get_micro_app_folder(app_name: str) -> str:
    """Path of a builtin micro-app bundle. Existence is checked at serve time."""
    return str(get_micro_apps_root() / app_name)


class MicroApp(Entity):
    type: str = APIField(default=BuiltinEntityType.MICRO_APP.value)
    code_base: Optional[AppCodebase] = NoDbBField(None)
    # Declared as APIFields so the delivery row is legible over the API. They
    # were plain fields, which persist (``skip_api_serializer``) but never
    # serialize outbound — leaving a row whose whole purpose is "where does this
    # app serve from" unable to answer that question to any client.
    location_type: AppLocationType = APIField(description="How this app's files are located")
    location_root: Optional[str] = APIField(default=None, description="Absolute directory the files are served from")
    domains: Optional[List[str]] = APIField(default=None, description="Custom domains routed to this app")
    default_agent_id: Optional[str] = APIField(default=None, description="Default agent ID for this micro app")
    artifact_id: Optional[str] = APIField(
        default=None,
        description="Artifact this delivers (the source plane); None for standalone folder/builtin apps",
    )
    project_id: Optional[str] = APIField(default=None, description="Owning project, mirroring the Artifact's", sharing=Sharing.PRIVATE)
    #: The app FOLDER on disk for an asset-backed app, stamped by the indexer.
    #: A plain string, not an FSRef — same shape as ``Dataset.asset_ref``. Empty
    #: for the imperative ``flow app serve`` rows, which have no asset of their own.
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
    description: Optional[str] = APIField(default=None, description="What the app is, for the asset browser")
    kind: KindStr = APIField(default="application.web", description="Dot-path ontology kind")
    build: str = APIField(default=".", description="Served subdir inside the app folder")

    name: str = EntityField(sharing=Sharing.SHARED)
    # NOT unique. It was, from when a micro-app name WAS its hostname and the
    # namespace was global. Host routing resolves by id (``request_info.
    # parse_micro_app_request``) and nothing reads ``get_by_name``, so the
    # constraint protected nothing while making the second app anyone names
    # "frontend" fail to save with a 409. Per-type global uniqueness is the
    # wrong shape for project-scoped apps; identity is ``id``, name is a label.
    _unique: ClassVar[List[str]] = []

    def __init__(self, **data):
        super().__init__(**data)
        # Artifact-backed apps deliberately build no AppCodebase: its __init__
        # creates `.flow/local/` INSIDE the folder, and writing scratch dirs into
        # a user's app just to read bytes out of it is not ours to do.
        if self.location_type in (AppLocationType.Folder, AppLocationType.Builtin):
            codebase_root = self._configured_root()
            self.validate_codebase_root(codebase_root)
            self.code_base = AppCodebase(root_folder=codebase_root)

    @field_validator("artifact_id", mode="before")
    @classmethod
    def _valid_artifact_id(cls, value):
        """Same gate as ``Deployment._valid_artifact_id`` — entity ids are v4/v5."""
        if value in (None, ""):
            return None
        candidate = str(value).strip()
        if not is_valid_entity_id(candidate):
            raise ValueError("artifact_id must be a UUID v4 or v5")
        return candidate

    def _configured_root(self) -> Optional[str]:
        if self.location_type == AppLocationType.Builtin:
            return get_micro_app_folder(self.location_root or self.name)
        return self.location_root

    def validate_codebase_root(self, codebase_root):
        """Config-level validation only.

        Existence is NOT checked here. An app is registered before its first
        build, and refusing to construct the entity would mean the row can only
        exist once the output does — the display could never say "not built
        yet", because there would be nothing to display.

        A misconfigured root is a 400-shaped ValueError at construction; a root
        that is merely absent is `AppNotBuilt` at serve time (see
        ``serving_root``). Same words, two different answers.
        """
        if not codebase_root:
            raise ValueError(f"app {self.name}({self.location_type}) folder is missing")
        if not os.path.isabs(codebase_root):
            raise ValueError(f"app {self.name}({self.location_type}) folder must be absolute path")

    def serving_root(self, *, env_segment: Optional[str] = None) -> Path:
        """The directory this app's files are served from.

        Folder/Builtin keep their historical ``public/`` convention. An
        Artifact-backed app serves straight out of its build output — a `dist/`
        produced by a normal frontend toolchain has no `public/` inside it. An
        Asset-backed app is the same idea addressed from the asset instead of a
        resolved-once absolute path: ``<app folder>/<build>``.
        """
        if self.location_type == AppLocationType.Asset:
            if not self.asset_ref:
                raise AppNotBuilt("<unset>")
            # No existence check here: ``serve_app_bytes`` already answers a
            # missing directory with the same ``AppNotBuilt`` ("run the build"),
            # exactly as it does for the Artifact branch below. Checking here too
            # would stat the tree again on every single served file.
            return Path(self.asset_ref) / (self.build or ".")

        if self.location_type == AppLocationType.Artifact:
            if not self.location_root:
                raise AppNotBuilt("<unset>")
            return Path(self.location_root)

        if self.location_type == AppLocationType.GCPBucket:
            # Not AppNotBuilt: that means "run the build", and the display turns
            # it into a build CTA. Bucket-hosted apps have nothing to build here.
            raise HTTPException(status_code=501, detail="GCPBucket apps are not servable from this instance")

        root = Path(self._configured_root() or "")
        if self.location_type == AppLocationType.Builtin:
            root = root / (env_segment or "graph") / "ui"
        return root / "public"

    @property
    def cache_control(self) -> str:
        """The Cache-Control every serve route on this row answers with.

        An asset-backed app is a folder under edit, not a released bundle with
        content-hashed filenames: its `app.js` keeps one name across every edit,
        so a heuristically-cached copy is the previous version.
        """
        return "no-cache" if self.location_type == AppLocationType.Asset else ASSET_CACHE_CONTROL

    def is_file_backed(self) -> bool:
        """Only an ``Asset``-backed app is a folder asset; the rest are DB-only.

        ``micro_app`` is a repo type because a webapp CAN be an asset on disk.
        A row registered by ``flow app serve`` is not one: it delivers the build
        output of a folder somewhere in the user's checkout and has no asset of
        its own. Without this, saving such a row would compute an ``asset_ref``
        under ``agentic-assets/webapp/`` and materialize an empty folder there
        for an app whose files live somewhere else entirely.
        """
        return self.location_type == AppLocationType.Asset

    @classmethod
    async def get_by_name(cls, name: str) -> Optional["MicroApp"]:
        return await cls.get_one({"name": name})

    @classmethod
    async def get_by_artifact_id(cls, artifact_id: str) -> Optional["MicroApp"]:
        return await cls.get_one({"artifact_id": artifact_id})

    @action.get()
    async def view(self, request: Request) -> Response:
        """Serve this app's files under the console API path."""
        url = str(request.url)
        service_log.info(f"view app {self.name}({self.typeid}): {url}")
        api_request: APIRequest = APIRequest.from_api_path(url)
        return await serve_app_bytes(
            self.serving_root(),
            api_request.sub_path,
            request,
            api_url_scheme=default_service_config.service_urls_config.api_url_scheme,
            cache_control=self.cache_control,
        )

    async def view_external_domain(self, request: Request) -> Response:
        """Serve this app on its own domain (cloud seam; no OSS caller today)."""
        request_info = get_current_request_info()
        service_log.info(f"view app {self.name}({self.typeid}): {request.url}")

        host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
        if not host:
            return Response(status_code=400, content="Bad request: missing host header")

        env_segment = "dev" if host.split("--")[0] == "dev" else "prod"
        return await serve_app_bytes(
            self.serving_root(env_segment=env_segment),
            (request_info.sub_path or "").lstrip("/"),
            request,
            # On its own domain the document must not be rewritten; under the
            # console path relative asset URLs need <base> to resolve.
            inject_base=not request_info.is_micro_app_request(),
            api_url_scheme=default_service_config.service_urls_config.api_url_scheme,
            cache_control=self.cache_control,
        )
