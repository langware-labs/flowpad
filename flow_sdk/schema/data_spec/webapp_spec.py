"""Filesystem contracts independent of application entities."""
from typing import Annotated, ClassVar, Literal, Optional, Union

from pydantic import ConfigDict, Field

from flow_sdk.schema.data_spec.service_endpoint_spec import MOUNT_PATTERN, TaggedProtocol, WebAudience
from flow_sdk.schema.data_spec.spec import DataSpec

WEBAPP_KIND = "application.web"


class WebappStaticServing(DataSpec):
    """Serve files from a folder of the app — relative to the app folder; empty means its ``build``."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    #: The discriminator. REQUIRED, not defaulted: the disk writer omits defaults,
    #: and a union written without its tag cannot be read back.
    type: Literal["static"]
    root: str = ""


class WebappPortSpec(DataSpec):
    """The port a process is served on in one environment."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    port: int = Field(ge=1, le=65535)
    #: The process can only run on this port: when another program holds it, starting is an error.
    #: False: the port is a preference, and a free one is picked when it is taken.
    required: bool = True


class WebappPortsSpec(DataSpec):
    """A process's port per environment. ``local`` — the machine the process runs on — is the only
    environment there is; any other key is refused rather than silently ignored."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    local: Optional[WebappPortSpec] = None


class WebappProxyServing(DataSpec):
    """Run a process and relay to it. ``{port}`` in ``start_cmd`` is the port it is started on: the one
    ``ports`` declares, else a free one."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    type: Literal["proxy"]
    start_cmd: str
    health: str = "/"
    #: The port the process is served on (``flow_sdk/core/app_ports.py`` is the one rule that reads it).
    ports: Optional[WebappPortsSpec] = None
    #: The older spelling of ``ports: {local: {port: N, required: true}}``; still read.
    port: Optional[int] = Field(default=None, ge=1, le=65535)
    #: Installs what the app needs before it can start (``npm ci``). Empty: derived from its package manager
    #: when it has a ``package.json`` (``webapp_setup.install_command``), else nothing to install.
    install_cmd: str = ""
    #: A path inside the app folder that exists once ``install_cmd`` has run (``frontend/node_modules``).
    #: Empty: a declared install is judged by its result, the app running.
    install_check: str = ""
    #: Builds the app before it starts, when it must be. Empty: no build step.
    build_cmd: str = ""

    def declared_port(self) -> Optional[WebappPortSpec]:
        """The port this process declares here, whichever way it is spelled; None when it declares none."""
        if self.ports is not None and self.ports.local is not None:
            return self.ports.local
        return WebappPortSpec(port=self.port) if self.port else None


WebappServing = Annotated[Union[WebappStaticServing, WebappProxyServing], Field(discriminator="type")]


class WebappMountSpec(DataSpec):
    """One way a webapp is served to a web audience, wherever it is placed — the TEMPLATE of a route.

    A placement has ONE proxy per audience (``admin``: the project's operators, ``app``: its end
    users); every app of the project is a route of one of them. The definition says which audience,
    where under it, and how to produce the bytes; a placement (this desktop, a cloud box) turns it
    into a route with a real port or a real folder. Nothing here is a fact about one machine.
    """

    spec_kind: ClassVar[str] = "webapp.mount"
    model_config = ConfigDict(extra="forbid", frozen=True)

    #: Which proxy serves it: the project's end users', or its operators'.
    audience: WebAudience = "app"
    #: Where under the audience proxy: ``""`` is that audience's root app, ``"docs"`` is ``/docs/``.
    #: Unsaid: the app's own name.
    path: Optional[str] = Field(default=None, pattern=MOUNT_PATTERN)
    serving: WebappServing = Field(default_factory=lambda: WebappStaticServing(type="static"))


class WebappServiceSpec(DataSpec):
    """A machine-called service a webapp brings along (its REST API) — the TEMPLATE of a ``service`` endpoint.

    Not a route: it is not a page of the app, and no audience opens it. A placement runs it and
    records it as an endpoint of its own, named ``<app>-<name>``.
    """

    spec_kind: ClassVar[str] = "webapp.service"
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str
    protocol: TaggedProtocol
    serving: WebappProxyServing


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
    #: How the app is served to a web audience when placed. Empty means the one obvious mount: the
    #: ``build`` folder, to the ``app`` audience, at the app's own name — see :func:`effective_mounts`.
    mounts: list[WebappMountSpec] = []
    #: The machine-called services the app brings along (its API), each an endpoint of its own.
    services: list[WebappServiceSpec] = []


def effective_mounts(mounts: list, services: list = ()) -> list:
    """The mounts a placement serves for an app: its declared ones, or the implicit static one.

    An app that declares only ``services`` is an API: it has no page, so no mount is implied."""
    return list(mounts) or ([] if services else [WebappMountSpec()])
