import hashlib
import mimetypes
import os
from flow_sdk._compat import StrEnum
from pathlib import Path
from typing import ClassVar, List, Optional

import anyio
from bs4 import BeautifulSoup
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, Response, StreamingResponse

from flow_sdk.config import default_service_config
import logging as service_log
from flow_sdk.api.api_types.api_field import APIField, NoDbBField
from flow_sdk.api.api_request import APIRequest
from flow_sdk.builtin.faas.codebase import AppCodebase
from flow_sdk.core import Entity, action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.utils import ROOT_FOLDER


class AppLocationType(StrEnum):
    Folder = "Folder"
    Builtin = "Builtin"
    GCPBucket = "GCPBucket"


# --- Utility: Calculate ETag for cache headers ---
def generate_etag(file_path: Path):
    with open(file_path, "rb") as f:
        content = f.read()
    return hashlib.md5(content).hexdigest()


async def async_file_iterator(file_path: str, chunk_size: int = 8192):
    async with await anyio.open_file(file_path, "rb") as f:
        while True:
            chunk = await f.read(chunk_size)
            if not chunk:
                break
            yield chunk


async def file_response(request: Request, requested_file: Path) -> FileResponse | Response:
    mime_type, _ = mimetypes.guess_type(str(requested_file))
    mime_type = mime_type or "application/octet-stream"

    # 🔁 Cache handling: basic ETag support
    etag = generate_etag(requested_file)
    if_none_match = request.headers.get("if-none-match")
    if if_none_match == etag:
        return Response(status_code=304)

    response = StreamingResponse(content=async_file_iterator(str(requested_file)), media_type=mime_type)
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "public, max-age=3600"
    return response


def get_micro_apps_root() -> Path:
    root_path_folder = Path(ROOT_FOLDER)
    return root_path_folder / "micro_apps"


def get_micro_app_folder(app_name: str):
    micro_apps_root = get_micro_apps_root()
    builtin_app_path = micro_apps_root / app_name
    if not builtin_app_path.exists():
        raise ValueError(f"App {app_name} does not exist")
    if not builtin_app_path.is_dir():
        raise ValueError(f"App {app_name} is not a directory")
    return str(builtin_app_path)


def inject_base_tag(html: str, base_url: str) -> str:
    """
    Injects a <base> tag into the <head> of an HTML document.
    Creates the <head> if it does not exist.

    :param html: The original HTML content as a string.
    :param base_url: The href value to set in the base tag.
    :return: Modified, tidied HTML with the base tag injected.
    """
    soup = BeautifulSoup(html, "html.parser")

    # Find or create <head>
    head = soup.head
    if not head:
        head = soup.new_tag("head")
        if soup.html:
            soup.html.insert(0, head)
        else:
            # Create <html> if not present
            html_tag = soup.new_tag("html")
            soup.insert(0, html_tag)
            html_tag.insert(0, head)

    # Check for existing <base> tag
    if not head.find("base"):
        # Create and insert the <base> tag
        base_tag = soup.new_tag("base", href=base_url)
        head.insert(0, base_tag)

    # Return tidied HTML (pretty print)
    return str(soup.prettify())


class MicroApp(Entity):
    type: str = APIField(default=BuiltinEntityType.MICRO_APP.value)
    code_base: Optional[AppCodebase] = NoDbBField(None)
    location_type: AppLocationType
    location_root: Optional[str] = None
    domains: Optional[List[str]] = None
    default_agent_id: Optional[str] = APIField(default=None, description="Default agent ID for this micro app")

    name: str
    _unique: ClassVar[List[str]] = ["name"]

    def __init__(self, **data):
        super().__init__(**data)
        codebase_root = None
        if self.location_type == AppLocationType.Folder:
            codebase_root = self.location_root
        if self.location_type == AppLocationType.Builtin:
            root_name = self.location_root or self.name
            codebase_root = get_micro_app_folder(root_name)
        self.validate_codebase_root(codebase_root)
        self.code_base = AppCodebase(root_folder=codebase_root)

    def validate_codebase_root(self, codebase_root):
        if not codebase_root:
            raise ValueError(f"app {self.name}({self.location_type}) folder is missing")
        if not os.path.isabs(codebase_root):
            raise ValueError(f"app {self.name}({self.location_type}) folder must be absolute path")
        if not os.path.exists(codebase_root):
            raise ValueError(f"app {self.name}({self.location_type}) folder does not exist")

    @classmethod
    async def get_by_name(cls, name: str) -> Optional["MicroApp"]:
        return await cls.get_one({"name": name})

    @action.get()
    async def view(self, request: Request) -> FileResponse | Response:
        url = str(request.url)
        service_log.info(f"view app {self.name}({self.typeid}): {url}")
        api_request: APIRequest = APIRequest.from_api_path(url)
        requested_path = api_request.sub_path
        if not requested_path:
            requested_path = "index.html"
        if not self.code_base:
            raise HTTPException(status_code=400, detail="App storage error")
        if self.location_type == AppLocationType.Builtin:
            # Update the requested path to include the graph path if its a builtin type
            codebase_root = str(Path(self.code_base.root_folder, "graph", "ui"))
            self.validate_codebase_root(codebase_root)
            self.code_base = AppCodebase(root_folder=codebase_root)
        requested_file = self.code_base.public_file_path(requested_path)
        service_log.info(f"view app {self.name} code base root: {self.code_base.root}")
        service_log.info(f"Requested path {requested_path}. requested file: {str(requested_file)}")
        service_log.info(
            f"Requested file exists: {str(requested_file.exists())}, is file: {str(requested_file.is_file())}"
        )

        if requested_file.exists() and requested_file.is_file():
            extension = requested_file.suffix
            if extension == ".html":
                request_url = request.url
                api_url_scheme = default_service_config.service_urls_config.api_url_scheme
                if request_url.scheme != api_url_scheme:
                    request_url = request_url.replace(scheme=api_url_scheme)
                # Inject <base> tag for HTML files
                base_url = str(request_url).split("?")[0]
                if not base_url.endswith("/"):
                    base_url += "/"
                html_content = requested_file.read_text()
                modified_html = inject_base_tag(html_content, base_url)
                return HTMLResponse(content=modified_html)
            return await file_response(request, requested_file)

        index_file = self.code_base.public_file_path("index.html")

        if not requested_file.exists() and index_file.exists():
            return await file_response(request, index_file)

        return Response(status_code=404, content=f"File not found:{str(requested_file)}. root:{get_micro_apps_root()}")

    async def view_external_domain(self, request: Request) -> FileResponse | Response:
        request_info = get_current_request_info()
        url = str(request.url)
        service_log.info(f"view app {self.name}({self.typeid}): {url}")
        requested_path = request_info.sub_path
        if not requested_path:
            requested_path = "index.html"

        host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
        if not host:
            return Response(status_code=400, content="Bad request: missing host header")

        # Use a local code_base variable to avoid modifying the cached instance
        code_base = self.code_base
        if self.location_type == AppLocationType.Builtin:
            # Update the requested path to include the env path
            codebase_root = str(
                Path(self.code_base.root_folder, "dev" if host.split("--")[0] == "dev" else "prod", "ui")
            )
            self.validate_codebase_root(codebase_root)
            code_base = AppCodebase(root_folder=codebase_root)

        if not code_base:
            raise HTTPException(status_code=400, detail="App storage error")

        requested_file = code_base.public_file_path(requested_path.lstrip("/"))
        service_log.info(f"view app {self.name} code base root: {code_base.root}")
        service_log.info(f"Requested path {requested_path}. requested file: {str(requested_file)}")
        service_log.info(
            f"Requested file exists: {str(requested_file.exists())}, is file: {str(requested_file.is_file())}"
        )

        if requested_file.exists() and requested_file.is_file():
            extension = requested_file.suffix
            if extension == ".html":
                request_url = request.url
                api_url_scheme = default_service_config.service_urls_config.api_url_scheme
                if request_url.scheme != api_url_scheme:
                    request_url = request_url.replace(scheme=api_url_scheme)
                # Inject <base> tag for HTML files
                base_url = str(request_url).split("?")[0]
                if not base_url.endswith("/"):
                    base_url += "/"
                html_content = requested_file.read_text()
                # If this is a micro app request, do not modify the HTML content
                if request_info.is_micro_app_request():
                    return HTMLResponse(content=html_content)
                # Otherwise, its a console request inject the base tag
                modified_html = inject_base_tag(html_content, base_url)
                return HTMLResponse(content=modified_html)
            return await file_response(request, requested_file)

        index_file = code_base.public_file_path("index.html")

        if not requested_file.exists() and index_file.exists():
            return await file_response(request, index_file)

        return Response(status_code=404, content=f"File not found:{str(requested_file)}. root:{get_micro_apps_root()}")
