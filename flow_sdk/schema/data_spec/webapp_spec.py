"""Filesystem contracts independent of application entities."""
from flow_sdk.schema.data_spec.spec import DataSpec

WEBAPP_KIND = "application.web"


class WebappManifestSpec(DataSpec):
    """``webapp.json`` — the shape of a webapp asset's main doc.

    Flat, like ``data_source.json``: the spec declares no ``FreeSection``, so
    ``_manifest_layout`` resolves to ``flat`` and the file reads as the plain
    object an author would write by hand.
    """

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
