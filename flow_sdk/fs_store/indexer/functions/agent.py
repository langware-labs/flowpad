"""Extractor + default body for AGENT records.

An Agent is a folder asset at ``agentic-assets/agent/<name>/agent.md``:
YAML frontmatter carries the launch bundle, the markdown body IS the
``system_prompt``. Discovery is the generic ``repo_assets_fn`` walk (gated on
``main_file``) — this module owns only the parse and the render, and both are
now the disk serializer's ``load`` / ``render``: the entity class declares the SHAPE, ``TypeInfo`` the layout.

``AgentSpec`` (``flow_sdk/builtin/agent.py``) is the one declaration of what
the document holds.

The entity owns the file (``owns_main_ref``), so the body is re-rendered on
every save. ``content`` therefore holds the BODY ONLY: if it still carried the
frontmatter, each save would append a duplicate block — the same round-trip
rule ``extract_spec`` documents.
"""
from __future__ import annotations
