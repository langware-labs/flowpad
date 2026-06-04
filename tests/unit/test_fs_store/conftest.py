"""Shared setup for fs_store unit tests.

Tests in this package construct ``FSIndexer`` directly and exercise the type
registry without booting the server. Production runs the declarative type-info
registrations at startup (``flow_sdk/server/app.py`` imports
``flow_sdk.fs_store.indexer.registrations``, which runs ``register_all()``).

Importing that module here once per session reproduces the same init, so
``SchemaRegistry.get("markdown")`` etc. resolve — without it the indexer walk
finds no registered type and skips every record.
"""
import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — side-effect: register_all()
