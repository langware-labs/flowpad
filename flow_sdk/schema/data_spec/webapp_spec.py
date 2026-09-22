"""Filesystem contracts independent of application entities."""
from typing import Annotated, ClassVar, Literal, Optional, Union

from pydantic import ConfigDict, Field

from flow_sdk.schema.data_spec.service_endpoint_spec import TaggedProtocol, WebAppProtocol
from flow_sdk.schema.data_spec.spec import DataSpec

WEBAPP_KIND = "application.web"


class WebappStaticServing(DataSpec):
    """Serve files from a folder of the app — relative to the app folder; empty means its ``build``."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    #: The discriminator. REQUIRED, not defaulted: the disk writer omits defaults,
    #: and a union written without its tag cannot be read back.
    type: Literal["static"]
    root: str = ""


class WebappProxyServing(DataSpec):
    """Run a process and relay to it. ``{port}`` in ``start_cmd`` is the port the placement assigns."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    type: Literal["proxy"]
    start_cmd: str
    health: str = "/"
    #: A fixed port when the process cannot be told one; otherwise the placement picks.
    port: Optional[int] = Field(default=None, ge=1, le=65535)


WebappServing = Annotated[Union[WebappStaticServing, WebappProxyServing], Field(discriminator="type")]


class WebappEndpointSpec(DataSpec):
    """One service a webapp exposes wherever it is placed — the TEMPLATE of a ``ServiceEndpoint``.

    The definition says what the app serves and how to start it; a placement
    (this desktop, a cloud box) turns each entry into a ``ServiceEndpoint`` with
    a real port and a real folder. Nothing here is a fact about one machine.
    """

    spec_kind: ClassVar[str] = "webapp.endpoint"
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str
    protocol: TaggedProtocol = Field(default_factory=WebAppProtocol)
    serving: WebappServing = Field(default_factory=lambda: WebappStaticServing(type="static"))
    supports_direct_access: bool = False


class WebappManifestSpec(DataSpec):
    """``webapp.json`` — the shape of a webapp asset's main doc.

    Flat, like ``data_driver.json``: the spec declares no ``FreeSection``, so
    ``_manifest_layout`` resolves to ``flat`` and the file reads as the plain
    object an author would write by hand.
    """

    main_file: ClassVar[str | None] = "webapp.json"

    #: The app's name AND its folder name. One noun.
    name: str = ""
    title: str = ""
    description: str = ""
    #: Dot-path ontology, same vocabulary as ``Artifact.kind``. What the app IS
    #: to whatever contains it: ``application.web.editor`` marks the app a
    #: parent asset opens to edit itself.
    kind: str = WEBAPP_KIND
    #: The subdir actually served, relative to the app folder. ``.`` for a
    #: static app that has no build step; ``dist`` for a toolchain that emits one.
    build: str = "."
    #: What the app exposes when placed. Empty means the one obvious service: the
    #: ``build`` folder, served as a ``web.app`` — see :func:`effective_endpoints`.
    endpoints: list[WebappEndpointSpec] = []


def effective_endpoints(name: str, endpoints: list) -> list:
    """The endpoints a placement exposes for an app: its declared ones, or the implicit static one."""
    return list(endpoints) or [WebappEndpointSpec(name=name or "app")]
