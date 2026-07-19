"""Provider-neutral application/deployment WorldView package.

Public services live in ``worldview.service`` and ``worldview.graph``.  This
package initializer intentionally stays import-light because Artifact imports
the leaf ontology module during entity registration.
"""

__all__: list[str] = []
