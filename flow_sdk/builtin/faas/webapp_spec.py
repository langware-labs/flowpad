"""``webapp.json`` — the manifest a webapp asset is authored as.

Kept apart from ``micro_app.py`` so the type registry (loaded by every
``flow`` CLI invocation via ``register_all``) can name the spec without
pulling fastapi/starlette and the serving stack along with it.
"""
from flow_sdk.schema.data_spec.webapp_spec import WEBAPP_KIND, WebappManifestSpec

__all__ = ["EDITOR_KIND", "VIEWER_KIND", "WEBAPP_KIND", "WebappManifestSpec"]

#: What an app's ``kind`` says it is to whatever contains it. Matched with the
#: shared dot-path ontology (``kind_matches``), so a descendant kind counts too.

EDITOR_KIND = "application.web.editor"
#: A viewer shows a VALUE of a kind -- a field, an example, a list of them -- inside another app's page.
VIEWER_KIND = "application.web.viewer"
