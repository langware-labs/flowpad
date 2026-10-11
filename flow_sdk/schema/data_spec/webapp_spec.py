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
    #: Installs what the app needs before it can start (``npm ci``). Empty: derived from its package manager
    #: when it has a ``package.json`` (``webapp_setup.install_command``), else nothing to install.
    install_cmd: str = ""
    #: Builds the app before it starts, when it must be. Empty: no build step.
    build_cmd: str = ""


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


#: A viewer shows a VALUE of a kind (not a whole entity) — once alone, or many as a collection.
ViewShape = Literal["single", "collection"]


class WebappViewSpec(DataSpec):
    """One kind a viewer app can show, and in which shapes. ``kind`` is a dotted kind matched by the
    ontology (``navigator`` covers ``navigator.decision``), or ``*`` for any kind -- the generic viewer."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: str
    shows: list[ViewShape] = ["single"]


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
    #: What an EDITOR edits beyond what contains it: kinds (``navigator.dataset``, or an
    #: ancestor like ``navigator``) and type names (``dataset``). Matched by
    #: ``flow_sdk.builtin.faas.editors`` -- a nested editor needs none of this.
    edits: list[str] = []
    #: What a VIEWER (``application.web.viewer``) shows: kinds, each as a single value and/or a
    #: collection. Matched by ``flow_sdk.builtin.faas.editors.viewers_for``.
    views: list[WebappViewSpec] = []
    #: A viewer's ES module, relative to the served ``build`` folder; it exports ``viewers``
    #: (``ts_sdk/src/viewers/contract.ts``).
    module: str = "viewer.js"
    #: The subdir actually served, relative to the app folder. ``.`` for a
    #: static app that has no build step; ``dist`` for a toolchain that emits one.
    build: str = "."
    #: What the app exposes when placed. Empty means the one obvious service: the
    #: ``build`` folder, served as a ``web.app`` — see :func:`effective_endpoints`.
    endpoints: list[WebappEndpointSpec] = []


def effective_endpoints(name: str, endpoints: list) -> list:
    """The endpoints a placement exposes for an app: its declared ones, or the implicit static one."""
    return list(endpoints) or [WebappEndpointSpec(name=name or "app")]
