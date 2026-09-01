"""``webapp.json`` — the manifest a webapp asset is authored as.

Kept apart from ``micro_app.py`` so the type registry (loaded by every
``flow`` CLI invocation via ``register_all``) can name the spec without
pulling fastapi/starlette and the serving stack along with it.
"""
from flow_sdk.schema.data_spec.spec import DataSpec

__all__ = ["EDITOR_KIND", "WEBAPP_KIND", "WebappManifestSpec"]

#: What an app's ``kind`` says it is to whatever contains it. Matched with the
#: shared dot-path ontology (``kind_matches``), so a descendant kind counts too.
WEBAPP_KIND = "application.web"
EDITOR_KIND = "application.web.editor"


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
